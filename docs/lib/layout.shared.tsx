import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

/** The mark: a box, and the copy a fork makes of it. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.5" y="6.5" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="9.5" y="2.5" width="12" height="12" rx="2" className="fill-fd-primary/25 stroke-fd-primary" strokeWidth="1.6" />
    </svg>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <Mark />
          {appName}
        </span>
      ),
    },
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Spunto Cloud', url: 'https://spunto.net', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
