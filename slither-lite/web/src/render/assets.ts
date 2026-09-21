const foodNames = ["blue", "green", "purple", "red", "yellow", "orange"] as const;

export interface GameAssets {
  food: HTMLImageElement[];
  body: HTMLImageElement;
  head: HTMLImageElement;
}

export async function loadAssets(): Promise<GameAssets> {
  const food = await Promise.all(foodNames.map((name) => loadImage(`/assets/${name}_orb.png`)));
  const [body, head] = await Promise.all([loadImage("/assets/body_red.png"), loadImage("/assets/yellow_head.png")]);
  return { food, body, head };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`Unable to load ${source}`)), { once: true });
    image.src = source;
  });
}
