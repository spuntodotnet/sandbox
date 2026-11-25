import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // The home is @spunto/brand-kit's (TypeScript source, like the design system it builds on).
  transpilePackages: ['@spunto/brand-kit', '@spunto/design-system'],
};

export default withMDX(config);
