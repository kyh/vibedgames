export const siteConfig = {
  name: "Vibedgames",
  shortName: "Vibedgames",
  description: "Games made with vibes 🎮",
  url:
    process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : "https://vibedgames.com",
  twitter: "@kaiyuhsu",
};
