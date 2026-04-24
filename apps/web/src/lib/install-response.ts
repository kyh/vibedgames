import installMd from "@/lib/install.md?raw";

const init: ResponseInit = {
  headers: {
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  },
};

export const installResponse = () => new Response(installMd, init);
