import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { OtelBootstrap } from '@/components/OtelBootstrap';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: '4D OSINT Command Center',
  description: 'Worldview scale OSINT visualization engine',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-black text-white antialiased overflow-hidden`}>
        <OtelBootstrap />
        {children}
      </body>
    </html>
  );
}
