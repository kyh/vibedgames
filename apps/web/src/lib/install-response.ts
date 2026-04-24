import installMd from "@/lib/install.md?raw";

export const installResponse = () =>
  new Response(installMd, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
