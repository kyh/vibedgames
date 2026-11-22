export interface CustomProp {
  readonly model: string;
  readonly u: number;
  readonly v: number;
  readonly yaw: number;
  readonly s: number;
  readonly solid?: boolean;
}

export const CUSTOM_PROPS: readonly CustomProp[] = [];
