import React, { memo } from 'react';
import { View, type ViewProps } from 'react-native';

export type CardProps = {
  children: React.ReactNode;
  /** Adds hairline border + soft warm shadow. Default true. */
  elevated?: boolean;
  padded?: boolean;
} & ViewProps;

/** Base surface — white card on paper, hairline border, warm shadow. */
export const Card = memo(function Card({
  children,
  elevated = true,
  padded = true,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <View
      {...rest}
      className={`rounded-lg bg-card ${padded ? 'p-lg' : ''} ${
        elevated ? 'border border-lineOnCard shadow-card' : ''
      } ${rest.className ?? ''}`}
    >
      {children}
    </View>
  );
});
