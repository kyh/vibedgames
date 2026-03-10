const colors = {
  tomato: {
    color: "hsl(10, 78%, 54%)",
    hue: "hsl(10, 77.3%, 79.5%)",
  },
  crimson: {
    color: "hsl(336, 80%, 57.8%)",
    hue: "hsl(335, 63.5%, 80.4%)",
  },
  pink: {
    color: "hsl(322, 65%, 54.5%)",
    hue: "hsl(323, 62%, 80.1%)",
  },
  plum: {
    color: "hsl(292, 45%, 51%)",
    hue: "hsl(295, 48.2%, 78.9%)",
  },
  indigo: {
    color: "hsl(226, 70%, 55.5%)",
    hue: "hsl(225, 77.4%, 82.1%)",
  },
  blue: {
    color: "hsl(206, 100%, 50%)",
    hue: "hsl(208, 77.5%, 76.9%)",
  },
  cyan: {
    color: "hsl(190, 95%, 39%)",
    hue: "hsl(189, 60.3%, 52.5%)",
  },
  green: {
    color: "hsl(151, 55%, 41.5%)",
    hue: "hsl(146, 38.5%, 69%)",
  },
  orange: {
    color: "hsl(24, 94%, 50%)",
    hue: "hsl(24, 100%, 75.3%)",
  },
};

const colorValues = Object.values(colors);

export const getRandomUniqueColor = (currentColors: string[]) => {
  const colorNames = colorValues.map((col) => col.color);
  const uniqueColors = colorNames.filter((color: string) => !currentColors.includes(color));
  const uniqueColor = uniqueColors[Math.floor(Math.random() * uniqueColors.length)];
  const uniqueColorSet = colorValues.find((color) => color.color === uniqueColor);
  return uniqueColorSet ?? getRandomColor();
};

export const getRandomColors = (qty: number) => {
  return sampleSize(colorValues, qty);
};

export const getRandomColor = () => {
  return colorValues[Math.floor(Math.random() * colorValues.length)];
};

export const getColorById = (
  id: string,
): {
  color: string;
  hue: string;
} => {
  return colorValues[hashCode(id, colorValues.length)]!;
};

const sampleSize = <T>(array: T[], size: number): T[] => {
  const shuffled = array.slice(0);
  let index = -1;
  const length = array.length;
  const lastIndex = length - 1;

  size = Math.min(size, length);
  while (++index < size) {
    const rand = index + Math.floor(Math.random() * (lastIndex - index + 1));
    const value = shuffled[rand]!;
    shuffled[rand] = shuffled[index]!;
    shuffled[index] = value;
  }
  return shuffled.slice(0, size);
};

const hashCode = (string?: string, mod?: number) => {
  let hash = 0;
  if (!string || string.length === 0) return hash;
  for (let i = 0; i < string.length; i++) {
    const chr = string.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  if (mod) return Math.abs(hash % mod);
  return hash;
};
