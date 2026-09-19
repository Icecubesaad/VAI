// Bundled photo assets — Metro resolves these to opaque asset IDs at build
// time (expo-image accepts the numeric source on native and web).
declare module '*.jpg' {
  const value: number;
  export default value;
}
