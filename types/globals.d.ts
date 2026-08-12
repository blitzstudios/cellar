/**
 * React Native's build-mode flag. It is a global the bundler substitutes, not a module anyone imports, so it is
 * declared here for the type checker rather than shipped in the package's own types.
 */
declare const __DEV__: boolean;
