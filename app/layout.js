import './globals.css';

export const metadata = {
  title: 'Xfinity Media | Customer Contact',
  description: 'Share your contact details with Xfinity Media.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
