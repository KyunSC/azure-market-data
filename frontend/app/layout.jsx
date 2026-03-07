import './globals.css'

export const metadata = {
  title: 'Market Data Dashboard',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
