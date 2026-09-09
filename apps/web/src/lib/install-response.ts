import installMd from "@/lib/install.md?raw";

const init: ResponseInit = {
  headers: {
    "Cache-Control": "public, max-age=300",
    "Content-Type": "text/markdown; charset=utf-8",
  },
};

export const installResponse = () => new Response(installMd, init);
