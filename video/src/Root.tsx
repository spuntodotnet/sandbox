import { Fragment } from "react";
import { Composition, Folder } from "remotion";
import { Chapter } from "./components/Chapter";
import { loadBrandFonts } from "./lib/fonts";
import { FPS, HEIGHT, WIDTH } from "./lib/timeline";
import { Stage } from "./components/Stage";
import { CHAPTERS } from "./chapters";

loadBrandFonts();

// One composition per chapter (what the docs page plays), and each scene alone, to iterate on it.
export const RemotionRoot: React.FC = () => (
  <>
    {CHAPTERS.map(([id, c]) => (
      <Composition
        key={id}
        id={`${c.meta.n}-${id}`}
        component={() => <Chapter meta={c.meta} scenes={c.timeline.scenes} components={c.components} />}
        durationInFrames={c.timeline.total}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    ))}
    <Folder name="scenes">
      {CHAPTERS.map(([id, c]) => (
        <Fragment key={id}>
          {c.timeline.scenes.map((s) => {
            const Scene = c.components[s.id];
            return (
              <Composition
                key={s.id}
                id={`${id}-${s.id}`}
                component={() => (
                  <Stage>
                    <Scene lines={s.lines} />
                  </Stage>
                )}
                durationInFrames={s.durationInFrames}
                fps={FPS}
                width={WIDTH}
                height={HEIGHT}
              />
            );
          })}
        </Fragment>
      ))}
    </Folder>
  </>
);
