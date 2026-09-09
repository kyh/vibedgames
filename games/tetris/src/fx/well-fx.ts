import { BoxGeometry, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry } from "three";
import type { Scene } from "three";

import type { Cell } from "../game/board";
import { DEATH_HEIGHT, WELL_CENTER_X, WELL_CENTER_Z, WELL_WIDTH } from "../shared/constants";

interface Mark {
  mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  age: number;
  life: number;
}
interface Streak {
  mesh: Mesh<BoxGeometry, MeshBasicMaterial>;
  length: number;
  bottom: number;
}
interface Pulse {
  kind: "power" | "rescue";
  age: number;
  y: number;
}

/** Four drop trails, 64 cell-contact rings, one well pulse, and the HUD's
 *  event notice + stack-height warning. Pure presentation, fed by the scene. */
export class WellFx {
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly marks: Mark[];
  private readonly streaks: Streak[];
  private readonly streakMaterial = new MeshBasicMaterial({
    depthWrite: false,
    opacity: 0,
    transparent: true,
  });
  private readonly pulseMesh: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly dangerMesh: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly notice = document.querySelector("#fx-notice");
  private readonly warning = document.querySelector("#height-warning");
  private cursor = 0;
  private dropAge = 1;
  private pulse: Pulse | null = null;
  private noticeLeft = 0;
  private danger = false;
  private warningText = "";
  private noticeOpacity = "";

  constructor(scene: Scene) {
    // Four-sided rings follow the square cells, rather than introducing a new silhouette.
    const ring = new RingGeometry(0.61, 0.69, 4);
    const makeRing = (color: number) => {
      const mesh = new Mesh(
        ring,
        new MeshBasicMaterial({ color, depthWrite: false, side: DoubleSide, transparent: true }),
      );
      mesh.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    this.marks = Array.from({ length: 64 }, () => ({ age: 0, life: 0, mesh: makeRing(0xffffff) }));
    const box = new BoxGeometry(0.08, 1, 0.08);
    this.streaks = Array.from({ length: 4 }, () => {
      const mesh = new Mesh(box, this.streakMaterial);
      mesh.visible = false;
      scene.add(mesh);
      return { bottom: 0, length: 0, mesh };
    });
    this.pulseMesh = makeRing(0xff_ff_ff);
    this.dangerMesh = makeRing(0xff_bd_73);
    this.dangerMesh.position.set(WELL_CENTER_X, DEATH_HEIGHT - 0.5, WELL_CENTER_Z);
    this.dangerMesh.scale.setScalar(WELL_WIDTH * 1.03);
    this.dangerMesh.material.opacity = 0.3;
  }

  hardDrop(start: Cell[], landing: Cell[], color: number): void {
    this.dropAge = 0;
    this.streakMaterial.color.set(color);
    for (let i = 0; i < this.streaks.length; i++) {
      const streak = this.streaks[i];
      const from = start[i];
      const to = landing[i];
      if (!streak) {
        continue;
      }
      streak.length = from && to ? Math.max(0, from.y - to.y) : 0;
      streak.bottom = to?.y ?? 0;
      streak.mesh.visible = !this.motion.matches && streak.length > 0;
      if (to) {
        streak.mesh.position.set(to.x, to.y + streak.length / 2, to.z);
      }
      streak.mesh.scale.y = streak.length;
    }
    this.contact(landing, color, false);
  }

  contact(cells: Cell[], color: number, sweep: boolean): void {
    for (const cell of cells) {
      const mark = this.marks[this.cursor];
      this.cursor = (this.cursor + 1) % this.marks.length;
      if (!mark) {
        continue;
      }
      mark.age = sweep && !this.motion.matches ? -(cell.x + cell.z) * 0.018 : 0;
      mark.life = sweep ? 0.48 : 0.3;
      mark.mesh.position.set(cell.x, cell.y + 0.49, cell.z);
      mark.mesh.material.color.set(color);
      mark.mesh.material.opacity = 0;
      mark.mesh.scale.setScalar(1);
      mark.mesh.visible = true;
    }
  }

  clear(cells: Cell[], lines: number, bothAxes: boolean): void {
    this.contact(cells, 0xff_ef_c2, true);
    this.announce(
      bothAxes ? `CROSS CLEAR · ${lines} LINES` : `${lines} LINE${lines === 1 ? "" : "S"} CLEAR`,
      "#ffefc2",
    );
  }

  orbitHint(): void {
    this.announce("VIEW TURNED · MOVEMENT FOLLOWS THIS CORNER", "#bcc8ff");
  }

  power(cells: Cell[]): void {
    this.contact(cells, 0xff_d8_6b, true);
    this.pulse = { age: 0, kind: "power", y: (cells[0]?.y ?? 0) + 0.49 };
    this.pulseMesh.material.color.set(0xff_d8_6b);
    this.announce("POWER SWEEP", "#ffd86b");
  }

  rescue(): void {
    this.pulse = { age: 0, kind: "rescue", y: -0.42 };
    this.pulseMesh.material.color.set(0xa7_e8_dc);
    this.announce("STACK SAVED", "#a7e8dc");
  }

  /** Called every frame; only writes the DOM when the warning changes. */
  setHeight(maxY: number, playing: boolean): void {
    const danger = playing && maxY >= DEATH_HEIGHT - 2;
    const layers = Math.max(0, DEATH_HEIGHT - maxY);
    const text = danger ? `STACK HIGH · ${layers} LAYER${layers === 1 ? "" : "S"} TO LIMIT` : "";
    if (danger === this.danger && text === this.warningText) {
      return;
    }
    this.danger = danger;
    this.warningText = text;
    this.dangerMesh.visible = danger;
    if (!this.warning) {
      return;
    }
    this.warning.hidden = !danger;
    this.warning.textContent = text;
  }

  private announce(text: string, color: string): void {
    if (this.notice) {
      this.notice.textContent = text;
      this.notice.style.color = color;
    }
    this.noticeLeft = 1.25;
    this.setNoticeOpacity("1");
  }

  private setNoticeOpacity(opacity: string): void {
    if (opacity === this.noticeOpacity) {
      return;
    }
    this.noticeOpacity = opacity;
    if (this.notice) {
      this.notice.style.opacity = opacity;
    }
  }

  update(dt: number): void {
    this.dropAge += dt;
    const dropT = Math.min(1, this.dropAge / 0.2);
    this.streakMaterial.opacity = 0.42 * (1 - dropT);
    for (const streak of this.streaks) {
      streak.mesh.visible = !this.motion.matches && dropT < 1 && streak.length > 0;
      const length = streak.length * (1 - dropT * 0.75);
      streak.mesh.scale.y = length;
      streak.mesh.position.y = streak.bottom + length / 2;
    }
    for (const mark of this.marks) {
      if (mark.life === 0) {
        continue;
      }
      mark.age += dt;
      const t = Math.max(0, mark.age / mark.life);
      if (t >= 1) {
        mark.life = 0;
        mark.mesh.visible = false;
        continue;
      }
      mark.mesh.material.opacity = mark.age < 0 ? 0 : 0.8 * (1 - t);
      mark.mesh.scale.setScalar(this.motion.matches ? 1 : 1 + t * 0.22);
    }
    const { pulse } = this;
    if (pulse) {
      pulse.age += dt;
      const t = pulse.age / 0.8;
      this.pulseMesh.visible = t < 1;
      this.pulseMesh.material.opacity = Math.max(0, 0.5 * (1 - t));
      const rise = pulse.kind === "rescue" && !this.motion.matches ? t * 3 : 0;
      this.pulseMesh.position.set(WELL_CENTER_X, pulse.y + rise, WELL_CENTER_Z);
      this.pulseMesh.scale.setScalar(WELL_WIDTH * (this.motion.matches ? 1 : 0.94 + t * 0.16));
      if (t >= 1) {
        this.pulse = null;
      }
    }
    if (this.noticeLeft > 0) {
      this.noticeLeft = Math.max(0, this.noticeLeft - dt);
      this.setNoticeOpacity(Math.min(1, this.noticeLeft / 0.25).toFixed(3));
    }
  }

  reset(): void {
    this.dropAge = 1;
    this.pulse = null;
    this.pulseMesh.visible = false;
    this.noticeLeft = 0;
    if (this.notice) {
      this.notice.textContent = "";
    }
    this.setNoticeOpacity("0");
    for (const mark of this.marks) {
      mark.life = 0;
      mark.mesh.visible = false;
    }
    for (const streak of this.streaks) {
      streak.mesh.visible = false;
    }
    this.setHeight(-1, false);
  }
}
