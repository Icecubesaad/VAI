import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect } from 'react-native-svg';

/**
 * GarmentArt — the onboarding float-card illustrations (no photo assets ship
 * in v1, and remote images would break offline): three stylized garments
 * drawn on a 100-grid. The emerald puffer nods to the founder's original
 * "Emerald Puff" reference. Pure content, aria-hidden wherever used.
 */

export function TeeArt({ size = 110 }: { size?: number }): React.JSX.Element {
  const body =
    'M31 25 L40 15 Q50 21 60 15 L69 25 L83 37 L73 48 L67 42 L67 82 Q50 87 33 82 L33 42 L27 48 L17 37 Z';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <Defs>
        <ClipPath id="tee-clip">
          <Path d={body} />
        </ClipPath>
      </Defs>
      <Path d={body} fill="#FBF9FF" stroke="#E4DBF6" strokeWidth={1.5} />
      <G clipPath="url(#tee-clip)">
        {/* the wild print */}
        <Circle cx="38" cy="34" r="10" fill="#F2A3DC" />
        <Circle cx="62" cy="44" r="13" fill="#8ED9B4" />
        <Circle cx="34" cy="60" r="9" fill="#F5D06F" />
        <Circle cx="63" cy="72" r="7" fill="#A78BFA" />
        <Circle cx="50" cy="30" r="5" fill="#8B6CEF" />
        <Rect x="20" y="88" width="60" height="14" fill="#EFE9FC" />
      </G>
      <Path d="M40 15 Q50 21 60 15 L57 19 Q50 24 43 19 Z" fill="#FFFFFF" />
    </Svg>
  );
}

export function PufferArt({ size = 110 }: { size?: number }): React.JSX.Element {
  const quilt = [30, 40, 50, 60, 70, 80];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <Defs>
        <ClipPath id="puffer-clip">
          <Path d="M30 20 h40 v68 h-40 Z M14 26 h16 v50 h-16 Z M70 26 h16 v50 h-16 Z" />
        </ClipPath>
      </Defs>
      {/* sleeves + torso */}
      <Rect x="13" y="25" width="17" height="52" rx="8.5" fill="#2F6B4F" />
      <Rect x="70" y="25" width="17" height="52" rx="8.5" fill="#2F6B4F" />
      <Rect x="29" y="18" width="42" height="70" rx="13" fill="#3E8563" />
      {/* quilting */}
      <G clipPath="url(#puffer-clip)">
        {quilt.map((y) => (
          <Line
            key={y}
            x1="10"
            y1={y}
            x2="90"
            y2={y - 3}
            stroke="rgba(255,255,255,0.30)"
            strokeWidth={3}
            strokeLinecap="round"
          />
        ))}
      </G>
      {/* stand collar + zip */}
      <Rect x="40" y="12" width="20" height="9" rx="4" fill="#2F6B4F" />
      <Line x1="50" y1="21" x2="50" y2="88" stroke="rgba(255,255,255,0.45)" strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function ShirtArt({ size = 110 }: { size?: number }): React.JSX.Element {
  const body =
    'M33 24 L42 15 H58 L67 24 L80 33 L76 90 H24 L20 33 Z';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <Defs>
        <ClipPath id="shirt-clip">
          <Path d={body} />
        </ClipPath>
      </Defs>
      <Path d={body} fill="#E8A177" />
      <G clipPath="url(#shirt-clip)">
        {/* woven stripes */}
        {[26, 36, 46, 56, 66, 76].map((x) => (
          <Rect key={x} x={x} y="10" width="4.5" height="85" fill="#F7E8D6" />
        ))}
        <Rect x="18" y="82" width="64" height="10" fill="#D98F63" />
      </G>
      <Path d="M42 15 H58 L54 20 Q50 23 46 20 Z" fill="#C97B4E" />
    </Svg>
  );
}
