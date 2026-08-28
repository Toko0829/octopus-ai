import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// `opsz` has to be requested by name. next/font ships the wght axis alone
// unless the others are listed, so `font-optical-sizing: auto` in globals.css
// had nothing to select and was doing nothing at all: the hero rendered in the
// text cut of Fraunces at 50px. SOFT rounds the terminals slightly, which keeps
// the display cut from reading as brittle at large sizes.
const display = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'opsz'],
  variable: '--font-display',
  display: 'swap',
});
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Octopus · the AI that runs your business',
  description:
    'Full-funnel digital marketing, run end-to-end by an AI with expert humans in the loop.',
};

// Set the saved theme before paint to avoid a flash, and mark that scripting is
// alive. The `js` class is what lets the landing's reveal animations START from
// hidden: without it every `.reveal` is simply visible, so a page whose client
// never runs is the finished page rather than a blank one. Adding the class here
// rather than in an effect means it lands before first paint, so there is no
// flash of the visible state before the animation begins.
const themeInit = `try{document.documentElement.classList.add('js');var t=localStorage.getItem('oc-theme');if(t){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {children}
      </body>
    </html>
  );
}
