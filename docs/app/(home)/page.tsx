import { ProductHome } from '@spunto/brand-kit/home';

/*
 * The home page is an edition of Spunto's brand kit (`@spunto/brand-kit`, its `sandbox` product):
 * the words, the figures with their sources and the terminal are decided there, in
 * coderhammer/spunto (packages/brand-kit/src/home/editions/sandbox.json). Changing this page is a
 * new edition and a new version of the kit, then its bump here.
 */
export default function HomePage() {
  return <ProductHome product="sandbox" />;
}
