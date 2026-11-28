/** A chapter of « From zero »: an MP4 of public/videos/from-zero, rendered from video/ (Remotion).
    Nothing loads before a click but its poster. */
export function ChapterVideo({ id, title }: { id: string; title: string }) {
  const src = `/videos/from-zero/${id}`;
  return (
    <figure className="not-prose my-6">
      <video
        controls
        playsInline
        preload="none"
        poster={`${src}.jpg`}
        aria-label={title}
        className="aspect-video w-full rounded-xl border bg-black"
      >
        <source src={`${src}.mp4`} type="video/mp4" />
      </video>
    </figure>
  );
}
