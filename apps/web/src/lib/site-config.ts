export const siteConfig = {
  name: "Vibedgames",
  shortName: "Vibedgames",
  description: "Games made with vibes 🎮",
  url:
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : import.meta.env.DEV
        ? "http://localhost:3000"
        : "https://vibedgames.com",
  twitter: "@kaiyuhsu",
};
