import { useEffect, useRef, useState } from "react";

export type GameAssets = {
  loaded: boolean;
  birdSprites?: HTMLImageElement[];
  numberSprites?: HTMLImageElement[];
  background?: HTMLImageElement;
  gameOver?: HTMLImageElement;
  message?: HTMLImageElement;
  pipe?: HTMLImageElement;
  sounds?: {
    point: HTMLAudioElement | null;
    hit: HTMLAudioElement | null;
    wing: HTMLAudioElement | null;
  };
};

export const useGameAssets = () => {
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const assetsRef = useRef<GameAssets>({
    loaded: false,
    sounds: {
      point: null,
      hit: null,
      wing: null,
    },
  });

  useEffect(() => {
    // Image assets
    const birdUrls = [
      "/yellowbird-downflap.png",
      "/yellowbird-midflap.png",
      "/yellowbird-upflap.png",
    ];
    const numberUrls = [
      "/0.png",
      "/1.png",
      "/2.png",
      "/3.png",
      "/4.png",
      "/5.png",
      "/6.png",
      "/7.png",
      "/8.png",
      "/9.png",
    ];
    const backgroundUrl = "/background-day.png";
    const gameOverUrl = "/gameover.png";
    const messageUrl = "/message.png";
    const pipeUrl = "/pipe-green.png";

    // Sound assets
    const soundUrls = {
      point: "/point.wav",
      hit: "/hit.wav",
      wing: "/wing.wav",
    };

    // Loader functions
    const loadImage = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

    const loadAudio = (url: string) =>
      new Promise<HTMLAudioElement>((resolve, reject) => {
        const audio = new Audio(url);
        audio.oncanplaythrough = () => resolve(audio);
        audio.onerror = reject;
        audio.src = url;
      });

    // Load all assets in parallel
    void Promise.all([
      // Load images
      ...birdUrls.map(loadImage),
      ...numberUrls.map(loadImage),
      loadImage(backgroundUrl),
      loadImage(gameOverUrl),
      loadImage(messageUrl),
      loadImage(pipeUrl),
      // Load sounds
      loadAudio(soundUrls.point),
      loadAudio(soundUrls.hit),
      loadAudio(soundUrls.wing),
    ]).then((loadedAssets) => {
      // Split the loaded assets into images and sounds
      const imageAssets = loadedAssets.slice(0, 17) as HTMLImageElement[];
      const soundAssets = loadedAssets.slice(17) as HTMLAudioElement[];
      assetsRef.current = {
        loaded: true,
        birdSprites: imageAssets.slice(0, 3),
        numberSprites: imageAssets.slice(3, 13),
        background: imageAssets[13],
        gameOver: imageAssets[14],
        message: imageAssets[15],
        pipe: imageAssets[16],
        sounds: {
          point: soundAssets[0] ?? null,
          hit: soundAssets[1] ?? null,
          wing: soundAssets[2] ?? null,
        },
      };
      setAssetsLoaded(true);
    });
  }, []);

  const playSound = (soundName: "point" | "hit" | "wing") => {
    const sound = assetsRef.current.sounds?.[soundName];
    if (sound) {
      sound.currentTime = 0;
      sound.play().catch((error) => console.error(`Error playing ${soundName} sound:`, error));
    }
  };

  return {
    assetsLoaded,
    assets: assetsRef.current,
    playSound,
  };
};
