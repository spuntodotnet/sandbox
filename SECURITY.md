# Security

Report a vulnerability privately, not in a public issue: **GitHub's private vulnerability reporting** on this
repository (Security → Report a vulnerability). If that does not work for you: mathieu@hammerbot.fr.

Say what it lets one do, the version (`sbx version`, or the commit) and how to reproduce it. You will get an answer
within a few days; a fix is released as a new version, with the report credited unless you would rather not.

## In scope

- Escaping a box: from inside a microVM to the host, or to another box (memory, disks, network, MMDS).
- The daemon's API (`spunto-sandboxd`, its socket and HTTP): doing what its caller should not be able to.
- The guest agent (`sbx-agent`).
- `install.sh` and the release artifacts: anything that would install something other than what was released.

Out of scope: what a box's own root does inside its box, and attacks needing root on the host already.
