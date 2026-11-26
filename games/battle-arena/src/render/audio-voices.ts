import { VoiceGroup } from "./voice-group";
import type { VoicePriority } from "./voice-group";

export class VoicePool {
  private readonly groups = new Set<VoiceGroup>();

  private readonly limit: number;
  private readonly routineLimit: number;

  constructor(limit: number, routineLimit: number) {
    this.limit = limit;
    this.routineLimit = routineLimit;
  }

  get count() {
    let n = 0;

    for (const group of this.groups) {
      n += group.count;
    }

    return n;
  }

  begin(priority: VoicePriority = "routine") {
    const group = new VoiceGroup(priority, this);
    this.groups.add(group);

    return group;
  }

  /** Routine voices respect both caps; essential voices evict the oldest routine group. */
  admit(group: VoiceGroup) {
    let total = 0;
    let routine = 0;

    for (const other of this.groups) {
      total += other.count;

      if (other.priority === "routine") {
        routine += other.count;
      }
    }

    if (group.priority === "routine") {
      return total < this.limit && routine < this.routineLimit;
    }

    while (total >= this.limit) {
      const oldest = this.oldestRoutine(group);

      if (!oldest) {
        return false;
      }

      total -= oldest.count;
      oldest.cancel();
    }

    return true;
  }

  private oldestRoutine(except: VoiceGroup) {
    for (const group of this.groups) {
      if (group !== except && group.priority === "routine" && group.count > 0) {
        return group;
      }
    }

    return null;
  }

  clear() {
    for (const group of this.groups) {
      group.cancel();
    }
  }

  retire(group: VoiceGroup) {
    this.groups.delete(group);
  }
}
