import React from 'react';

type GapcodeLogoProps = {
  className?: string;
};

const GapcodeLogo = ({ className = 'w-5 h-5' }: GapcodeLogoProps) => {
  return (
    <img
      src="/icons/gapcode.png"
      alt="GapCode"
      className={className}
    />
  );
};

export default GapcodeLogo;
