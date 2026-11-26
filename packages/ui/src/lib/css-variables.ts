/** The name of a CSS custom property, which an inline `style` may set beside the standard ones. */
export type CssVariable = `--${string}`;

declare module "react" {
  interface CSSProperties {
    [variable: CssVariable]: string | number | undefined;
  }
}
