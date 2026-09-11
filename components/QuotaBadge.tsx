import React, { memo } from 'react';
import { CounterBadge } from './CounterBadge';

export type QuotaBadgeProps = {
  /** Renders remaining, e.g. 3 of cap 5 → "3 of 5 left". */
  left: number;
  cap: number;
  /** One-tap upgrade — opens the paywall route. */
  onPress?: () => void;
  testID?: string;
};

/**
 * Frontend alias for {@link CounterBadge} (CONTRACT-frontend name).
 * Canonical component stays `CounterBadge` (`remaining/total/onUpgrade`);
 * this wrapper maps the `left/cap/onPress` call sites in `app/` onto it.
 * Copy contract: "X of 5 left" free lifetime; exhausted state offers upgrade.
 */
export const QuotaBadge = memo(function QuotaBadge({
  left,
  cap,
  onPress,
  testID,
}: QuotaBadgeProps): React.JSX.Element {
  return (
    <CounterBadge
      remaining={left}
      total={cap}
      onUpgrade={onPress ?? (() => undefined)}
      testID={testID}
    />
  );
});
