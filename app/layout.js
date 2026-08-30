import "./globals.css";

export const metadata = {
  title: "Answer Mapper",
  description:
    "Upload a question paper and a handwritten answer sheet to extract, map, and review answers side by side.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
