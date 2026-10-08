const host = document.querySelector("#game");
const canvas = document.createElement("canvas");
canvas.width = 800;
canvas.height = 600;
host?.append(canvas);

const ctx = canvas.getContext("2d");
if (ctx) {
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "28px system-ui";
  ctx.fillText("__VG_SLUG__", canvas.width / 2, canvas.height / 2 - 8);
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#aaa";
  ctx.fillText("Edit src/main.ts to start building.", canvas.width / 2, canvas.height / 2 + 22);
}
