// sbx-agent: what runs inside a Spunto Sandbox microVM so that its host can exec, open a shell,
// read and write files and reach a port in it.
//
// It listens on the guest's own address (172.16.0.2, the same in every box), which nothing but the
// host can reach: the host opens a connection from the box's network namespace, the box's namespace
// drops everything the guest sends unless it answers what the host opened, and no other box or
// network is routed there. Each connection carries one request, framed (protocol.md):
//
//	frame = type (1 byte) · length (4 bytes, big endian) · payload
//
// The first frame is the hello ('h', JSON: the box's token and the operation); then stdin, resize,
// signal frames one way, stdout, stderr, exit frames the other.
//
// It is started by the box's bootstrap (the daemon's), with the env the guest's init read from
// MMDS. The init signals it after a load of the box's RAM (USR2: nothing to do, the host reconnects)
// and after a fork (the copy's new env is in place: the token is read again).
package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var version = "dev"

const (
	listenAddr = "172.16.0.2:47771"
	maxFrame   = 4 << 20
)

// Frame types. Client → agent: hello, data (stdin or a write's bytes), close (end of stdin),
// resize, signal. Agent → client: ready, stdout (or a read's bytes, or a tunnel's), stderr, exit,
// error.
const (
	tHello  = 'h'
	tData   = '0'
	tClose  = 'c'
	tResize = 'r'
	tSignal = 'k'

	tReady  = 'o'
	tStdout = '1'
	tStderr = '2'
	tExit   = 'x'
	tError  = 'e'
)

type hello struct {
	Token string `json:"token"`
	Op    string `json:"op"` // exec | read | write | connect | info

	// exec
	Cmd    []string          `json:"cmd,omitempty"`
	Env    map[string]string `json:"env,omitempty"`
	Cwd    string            `json:"cwd,omitempty"`
	User   string            `json:"user,omitempty"`
	Tty    *winsize          `json:"tty,omitempty"`
	Detach bool              `json:"detach,omitempty"`

	// read, write
	Path string `json:"path,omitempty"`
	Mode string `json:"mode,omitempty"`

	// connect
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
}

type winsize struct {
	Rows uint16 `json:"rows"`
	Cols uint16 `json:"cols"`
}

type conn struct {
	c  net.Conn
	r  *bufio.Reader
	mu sync.Mutex
}

func (k *conn) send(t byte, payload []byte) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	var h [5]byte
	h[0] = t
	binary.BigEndian.PutUint32(h[1:], uint32(len(payload)))
	if _, err := k.c.Write(h[:]); err != nil {
		return err
	}
	_, err := k.c.Write(payload)
	return err
}

func (k *conn) sendJSON(t byte, v any) error {
	b, _ := json.Marshal(v)
	return k.send(t, b)
}

func (k *conn) fail(format string, a ...any) {
	_ = k.sendJSON(tError, map[string]string{"message": fmt.Sprintf(format, a...)})
}

func (k *conn) read() (byte, []byte, error) {
	var h [5]byte
	if _, err := io.ReadFull(k.r, h[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h[1:])
	if n > maxFrame {
		return 0, nil, fmt.Errorf("frame of %d bytes", n)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(k.r, b); err != nil {
		return 0, nil, err
	}
	return h[0], b, nil
}

// A writer that sends what is written as frames of one type: a process's stdout or stderr.
type frameWriter struct {
	k *conn
	t byte
}

func (w frameWriter) Write(p []byte) (int, error) {
	for off := 0; off < len(p); off += 64 << 10 {
		end := min(off+64<<10, len(p))
		if err := w.k.send(w.t, p[off:end]); err != nil {
			return off, err
		}
	}
	return len(p), nil
}

// ── The box's identity: its token, read from the env file the init keeps ─────

var (
	tokenMu sync.RWMutex
	token   = os.Getenv("SPUNTO_SANDBOX_TOKEN")
)

// After a fork, the init has put the copy's env in place before it signals: the token is the copy's.
func reloadToken() {
	f := os.Getenv("SPUNTO_AGENT_ENV_FILE")
	if f == "" {
		return
	}
	b, err := os.ReadFile(f)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "SPUNTO_SANDBOX_TOKEN="); ok {
			v = strings.Trim(v, "'")
			tokenMu.Lock()
			token = v
			tokenMu.Unlock()
		}
	}
}

func tokenOK(t string) bool {
	tokenMu.RLock()
	defer tokenMu.RUnlock()
	return token != "" && subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1
}

// ── What a process gets ──────────────────────────────────────────────────────

// The box's env without what is the agent's own: its token, the init's files.
func baseEnv() []string {
	out := []string{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == "SPUNTO_SANDBOX_TOKEN" || strings.HasPrefix(k, "SPUNTO_AGENT_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func withEnv(env []string, extra map[string]string) []string {
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	has := func(k string) bool {
		for _, kv := range env {
			if strings.HasPrefix(kv, k+"=") {
				return true
			}
		}
		return false
	}
	defaults := map[string]string{"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8"}
	for k, v := range defaults {
		if !has(k) {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// A user of /etc/passwd, by name or uid: its uid, gid and home.
func lookupUser(name string) (uint32, uint32, string, error) {
	b, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return 0, 0, "", err
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Split(line, ":")
		if len(f) < 7 || (f[0] != name && f[2] != name) {
			continue
		}
		uid, _ := strconv.Atoi(f[2])
		gid, _ := strconv.Atoi(f[3])
		return uint32(uid), uint32(gid), f[5], nil
	}
	return 0, 0, "", fmt.Errorf("no user %q in /etc/passwd", name)
}

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

// A new pseudo-terminal: its master, and the path of its slave.
func openPty() (*os.File, *os.File, error) {
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	var unlock int32
	if err := ioctl(ptmx.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		ptmx.Close()
		return nil, nil, err
	}
	var n uint32
	if err := ioctl(ptmx.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); err != nil {
		ptmx.Close()
		return nil, nil, err
	}
	pts, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		ptmx.Close()
		return nil, nil, err
	}
	return ptmx, pts, nil
}

func setSize(f *os.File, w winsize) {
	ws := [4]uint16{w.Rows, w.Cols, 0, 0}
	_ = ioctl(f.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func exitOf(err error) (int, string) {
	if err == nil {
		return 0, ""
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal()), ws.Signal().String()
		}
		return ee.ExitCode(), ""
	}
	return 127, ""
}

var signals = map[string]syscall.Signal{"SIGINT": syscall.SIGINT, "SIGTERM": syscall.SIGTERM, "SIGKILL": syscall.SIGKILL, "SIGHUP": syscall.SIGHUP, "SIGQUIT": syscall.SIGQUIT, "SIGUSR1": syscall.SIGUSR1, "SIGUSR2": syscall.SIGUSR2}

// ── Operations ───────────────────────────────────────────────────────────────

func doExec(k *conn, h hello) {
	if len(h.Cmd) == 0 {
		k.fail("exec: no command")
		return
	}
	cmd := exec.Command(h.Cmd[0], h.Cmd[1:]...)
	env := baseEnv()
	if h.User != "" && h.User != "root" && h.User != "0" {
		uid, gid, home, err := lookupUser(h.User)
		if err != nil {
			k.fail("exec: %v", err)
			return
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
		env = append(env, "HOME="+home, "USER="+h.User, "LOGNAME="+h.User)
	}
	cmd.Env = withEnv(env, h.Env)
	cmd.Dir = h.Cwd
	if cmd.Dir == "" {
		if st, err := os.Stat("/workspace"); err == nil && st.IsDir() {
			cmd.Dir = "/workspace"
		} else {
			cmd.Dir = "/"
		}
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}

	// Detached: started in a session of its own, its output in a log file, the call answered at once.
	// It outlives the connection, the agent and a new identity of the box.
	if h.Detach {
		logDir := os.Getenv("SBX_AGENT_LOG_DIR")
		if logDir == "" {
			logDir = "/var/log/sbx"
		}
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			k.fail("exec: %v", err)
			return
		}
		cmd.SysProcAttr.Setsid = true
		devnull, _ := os.Open(os.DevNull)
		cmd.Stdin = devnull
		logf, err := os.CreateTemp(logDir, "exec-*.log")
		if err != nil {
			k.fail("exec: %v", err)
			return
		}
		cmd.Stdout, cmd.Stderr = logf, logf
		if err := cmd.Start(); err != nil {
			k.fail("exec: %v", err)
			return
		}
		final := filepath.Join(logDir, fmt.Sprintf("%d.log", cmd.Process.Pid))
		_ = os.Rename(logf.Name(), final)
		logf.Close()
		devnull.Close()
		go func() { _ = cmd.Wait() }()
		_ = k.sendJSON(tExit, map[string]any{"code": 0, "pid": cmd.Process.Pid, "log": final})
		return
	}

	var ptmx *os.File
	var stdin io.WriteCloser
	if h.Tty != nil {
		m, pts, err := openPty()
		if err != nil {
			k.fail("exec: no pseudo-terminal: %v", err)
			return
		}
		ptmx = m
		defer ptmx.Close()
		setSize(ptmx, *h.Tty)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = pts, pts, pts
		cmd.SysProcAttr.Setsid = true
		cmd.SysProcAttr.Setctty = true
		cmd.SysProcAttr.Ctty = 0
		hasTerm := false
		for _, kv := range cmd.Env {
			hasTerm = hasTerm || strings.HasPrefix(kv, "TERM=")
		}
		if !hasTerm {
			cmd.Env = append(cmd.Env, "TERM=xterm-256color")
		}
		if err := cmd.Start(); err != nil {
			pts.Close()
			k.fail("exec: %v", err)
			return
		}
		pts.Close()
		stdin = ptmx
	} else {
		// A process group of its own: a signal goes to what it started too, and the init restarting
		// the agent (a new identity) does not take it down.
		cmd.SysProcAttr.Setpgid = true
		w, err := cmd.StdinPipe()
		if err != nil {
			k.fail("exec: %v", err)
			return
		}
		stdin = w
		cmd.Stdout = frameWriter{k, tStdout}
		cmd.Stderr = frameWriter{k, tStderr}
		if err := cmd.Start(); err != nil {
			k.fail("exec: %v", err)
			return
		}
	}
	_ = k.sendJSON(tReady, map[string]any{"pid": cmd.Process.Pid})

	pgid := cmd.Process.Pid
	var ended atomic.Bool
	// Never once it has been waited for: its pid may be another process's by then.
	kill := func(s syscall.Signal) {
		if !ended.Load() {
			_ = syscall.Kill(-pgid, s)
		}
	}

	// The client's frames: stdin, its end, resizes, signals. Gone before the process: a hangup.
	go func() {
		for {
			t, b, err := k.read()
			if err != nil {
				kill(syscall.SIGHUP)
				return
			}
			switch t {
			case tData:
				_, _ = stdin.Write(b)
			case tClose:
				if ptmx != nil {
					_, _ = stdin.Write([]byte{4}) // ^D, the terminal's end of input
				} else {
					_ = stdin.Close()
				}
			case tResize:
				var w winsize
				if json.Unmarshal(b, &w) == nil && ptmx != nil {
					setSize(ptmx, w)
				}
			case tSignal:
				var s struct{ Signal string }
				if json.Unmarshal(b, &s) == nil {
					if sig, ok := signals[strings.ToUpper(s.Signal)]; ok {
						kill(sig)
					}
				}
			}
		}
	}()

	var copied sync.WaitGroup
	if ptmx != nil {
		copied.Add(1)
		go func() {
			defer copied.Done()
			_, _ = io.Copy(frameWriter{k, tStdout}, ptmx)
		}()
	}
	err := cmd.Wait()
	ended.Store(true)
	if ptmx != nil {
		// What the terminal still holds: read until the slave side is gone (EIO), briefly.
		done := make(chan struct{})
		go func() { copied.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(200 * time.Millisecond):
		}
	}
	code, sig := exitOf(err)
	out := map[string]any{"code": code}
	if sig != "" {
		out["signal"] = sig
	}
	_ = k.sendJSON(tExit, out)
}

func doRead(k *conn, h hello) {
	f, err := os.Open(h.Path)
	if err != nil {
		k.fail("read: %v", err)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		k.fail("read: %s is not a file", h.Path)
		return
	}
	_ = k.sendJSON(tReady, map[string]any{"size": st.Size(), "mode": fmt.Sprintf("%o", st.Mode().Perm())})
	n, err := io.Copy(frameWriter{k, tStdout}, f)
	if err != nil {
		k.fail("read: %v", err)
		return
	}
	_ = k.sendJSON(tExit, map[string]any{"code": 0, "bytes": n})
}

func doWrite(k *conn, h hello) {
	if h.Path == "" || !filepath.IsAbs(h.Path) {
		k.fail("write: an absolute path, please")
		return
	}
	mode := os.FileMode(0o644)
	if h.Mode != "" {
		if m, err := strconv.ParseUint(h.Mode, 8, 32); err == nil {
			mode = os.FileMode(m)
		}
	}
	if err := os.MkdirAll(filepath.Dir(h.Path), 0o755); err != nil {
		k.fail("write: %v", err)
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(h.Path), ".sbx-write-*")
	if err != nil {
		k.fail("write: %v", err)
		return
	}
	defer os.Remove(tmp.Name())
	_ = k.sendJSON(tReady, map[string]any{})
	var n int64
	for {
		t, b, err := k.read()
		if err != nil {
			tmp.Close()
			return
		}
		if t == tClose {
			break
		}
		if t == tData {
			if _, err := tmp.Write(b); err != nil {
				tmp.Close()
				k.fail("write: %v", err)
				return
			}
			n += int64(len(b))
		}
	}
	if err := tmp.Chmod(mode); err != nil {
		k.fail("write: %v", err)
		return
	}
	if err := tmp.Close(); err != nil {
		k.fail("write: %v", err)
		return
	}
	if err := os.Rename(tmp.Name(), h.Path); err != nil {
		k.fail("write: %v", err)
		return
	}
	_ = k.sendJSON(tExit, map[string]any{"code": 0, "bytes": n})
}

func doConnect(k *conn, h hello) {
	host := h.Host
	if host == "" {
		host = "127.0.0.1"
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(h.Port)), 5*time.Second)
	if err != nil {
		k.fail("connect: %v", err)
		return
	}
	defer c.Close()
	_ = k.sendJSON(tReady, map[string]any{})
	go func() {
		for {
			t, b, err := k.read()
			if err != nil {
				c.Close()
				return
			}
			if t == tData {
				if _, err := c.Write(b); err != nil {
					return
				}
			}
			if t == tClose {
				if tc, ok := c.(*net.TCPConn); ok {
					_ = tc.CloseWrite()
				}
			}
		}
	}()
	_, _ = io.Copy(frameWriter{k, tStdout}, c)
	_ = k.sendJSON(tExit, map[string]any{"code": 0})
}

func doInfo(k *conn) {
	host, _ := os.Hostname()
	up := ""
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		up = strings.Fields(string(b))[0]
	}
	_ = k.sendJSON(tExit, map[string]any{"code": 0, "version": version, "hostname": host, "uptime": up, "pid": os.Getpid()})
}

func serve(c net.Conn) {
	defer c.Close()
	k := &conn{c: c, r: bufio.NewReaderSize(c, 64<<10)}
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	t, b, err := k.read()
	if err != nil || t != tHello {
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	var h hello
	if err := json.Unmarshal(b, &h); err != nil {
		k.fail("bad hello: %v", err)
		return
	}
	if !tokenOK(h.Token) {
		k.fail("refused: not this box's token")
		return
	}
	switch h.Op {
	case "exec":
		doExec(k, h)
	case "read":
		doRead(k, h)
	case "write":
		doWrite(k, h)
	case "connect":
		doConnect(k, h)
	case "info":
		doInfo(k)
	default:
		k.fail("unknown operation %q", h.Op)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	// What the init reads to signal us: our pid, and the signals we understand — REIDENTIFY says a
	// fork's copy may keep us (and every process) and hand us its new env instead of a restart.
	if f := os.Getenv("SPUNTO_AGENT_PIDFILE"); f != "" {
		_ = os.WriteFile(f, []byte(strconv.Itoa(os.Getpid())), 0o600)
	}
	if f := os.Getenv("SPUNTO_AGENT_SIGNALS_FILE"); f != "" {
		_ = os.WriteFile(f, []byte("USR1 USR2 REIDENTIFY\n"), 0o600)
	}
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, syscall.SIGUSR1, syscall.SIGUSR2)
	go func() {
		for range sig {
			reloadToken()
		}
	}()
	signal.Ignore(syscall.SIGPIPE, syscall.SIGHUP)

	addr := listenAddr
	// Elsewhere than in a box (its tests): SBX_AGENT_LISTEN=127.0.0.1:0 — the address it took is printed.
	if a := os.Getenv("SBX_AGENT_LISTEN"); a != "" {
		addr = a
	}
	var l net.Listener
	var err error
	// The guest's address is there from the kernel's command line (ip=…), but be patient.
	for i := 0; i < 100; i++ {
		if l, err = net.Listen("tcp", addr); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "sbx-agent: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "sbx-agent %s listening on %s\n", version, l.Addr())
	for {
		c, err := l.Accept()
		if err != nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		go serve(c)
	}
}
