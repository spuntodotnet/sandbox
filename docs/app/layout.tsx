import type { Metadata } from 'next';
import { Geist, JetBrains_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';
import './brand-fonts.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: { default: 'Spunto Sandbox — Firecracker microVMs on your own machine', template: '%s — Spunto Sandbox' },
  description: 'An OCI image in, a microVM in seconds. A pause keeps the memory, a fork copies a running VM. Open source, self-hosted: the engine behind Spunto Cloud.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
