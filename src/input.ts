/** Состояние клавиатуры. Используем e.code — не зависит от раскладки. */
export class Input {
  private keys = new Set<string>();
  /** Нажатия, ещё не забранные через takePress (чтобы не пропустить короткий тап между кадрами) */
  private presses = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      if (!e.repeat) this.presses.add(e.code);
      this.keys.add(e.code);
      // Пробел прокручивает страницу и жмёт сфокусированные кнопки — в игре это не нужно
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    // Если окно потеряло фокус — сбрасываем, чтобы персонаж не "залип"
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.presses.clear();
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Было ли нажатие клавиши с прошлого вызова (срабатывает один раз на нажатие) */
  takePress(code: string): boolean {
    return this.presses.delete(code);
  }

  /** Направление движения по WASD/стрелкам, ненормализованное */
  moveAxis(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.isDown("KeyW") || this.isDown("ArrowUp")) z += 1;
    if (this.isDown("KeyS") || this.isDown("ArrowDown")) z -= 1;
    if (this.isDown("KeyD") || this.isDown("ArrowRight")) x += 1;
    if (this.isDown("KeyA") || this.isDown("ArrowLeft")) x -= 1;
    return { x, z };
  }
}
