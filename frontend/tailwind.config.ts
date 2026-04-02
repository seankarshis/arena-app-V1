import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    borderRadius: {
      none: '0px',
      sm: '2px',
      DEFAULT: '2px',
      md: '4px',
      lg: '6px',
      xl: '8px',
      '2xl': '12px',
      pill: '999px',
      full: '9999px',
    },
    extend: {
      colors: {
        'horizon-red': 'rgb(var(--c-horizon-red) / <alpha-value>)',
        graphite: 'rgb(var(--c-graphite) / <alpha-value>)',
        ivory: 'rgb(var(--c-ivory) / <alpha-value>)',
        grey: 'rgb(var(--c-grey) / <alpha-value>)',
        'dark-maroon': 'rgb(var(--c-dark-maroon) / <alpha-value>)',
        'ivory-tint': 'rgb(var(--c-ivory-tint) / <alpha-value>)',
        'logo-grey': 'rgb(var(--c-logo-grey) / <alpha-value>)',
        'arena-gold': 'rgb(var(--c-arena-gold) / <alpha-value>)',
        'arena-amber': 'rgb(var(--c-arena-amber) / <alpha-value>)',
        'arena-copper': 'rgb(var(--c-arena-copper) / <alpha-value>)',
        'arena-wine': 'rgb(var(--c-arena-wine) / <alpha-value>)',
      },
      fontFamily: {
        primary: 'var(--font-primary)',
        hero: 'var(--font-hero)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '1.4' }],
      },
      letterSpacing: {
        stat: '0.05em',
        nav: '0.04em',
        label: '0.07em',
        wide: '0.1em',
      },
      keyframes: {
        'arena-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'arena-ptt-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.85' },
        },
        'arena-reconnect-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
      },
      animation: {
        'arena-blink': 'arena-blink 1s step-end infinite',
        'arena-ptt-pulse': 'arena-ptt-pulse 1.5s ease-in-out infinite',
        'arena-reconnect-pulse': 'arena-reconnect-pulse 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
