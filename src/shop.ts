import { canCraft, hasIngredient, ingredientTitle, visibleRecipes, type CraftHost, type Recipe } from "./recipes";
import type { ShopItem } from "./shopItems";
import type { WeaponDef, WeaponId } from "./weapons";
import type { FortuneWheel } from "./wheel";

export type ShopTab = "wheel" | "shop" | "craft";

/** Что магазину нужно от игры. Деньги, ассортимент и инвентарь — в Game; здесь только DOM */
export interface ShopActions {
  host: CraftHost;
  stock(): { items: ShopItem[]; weapon: WeaponDef | null };
  /** Купон включён: следующая покупка за полцены */
  couponMode: boolean;
  toggleCoupon(): void;
  /** Цена с учётом купона */
  price(base: number): number;
  buyItem(item: ShopItem): boolean;
  buyWeapon(w: WeaponDef): boolean;
  sellWeapon(id: WeaponId): void;
  craft(r: Recipe): boolean;
}

/**
 * Экран B: вкладки «Колесо / Магазин / Крафт». Колесо рисует FortuneWheel, магазин и крафт — карточки здесь.
 * Магазин перерисовывается целиком после каждого действия — данных мало, проще, чем дифф.
 */
export class Shop {
  private tabs = document.getElementById("shopTabs")!;
  private panels: Record<ShopTab, HTMLElement> = {
    wheel: document.getElementById("tabWheel")!,
    shop: document.getElementById("tabShop")!,
    craft: document.getElementById("tabCraft")!,
  };
  private goldEl = document.getElementById("shopGold")!;
  private stockEl = document.getElementById("shopStock")!;
  private sellEl = document.getElementById("shopSell")!;
  private couponBtn = document.getElementById("shopCoupon") as HTMLButtonElement;
  private msgEl = document.getElementById("shopMsg")!;
  private craftEl = document.getElementById("craftList")!;
  private closeBtn = document.getElementById("shopClose") as HTMLButtonElement;

  private actions: ShopActions | null = null;
  tab: ShopTab = "wheel";

  constructor(private wheel: FortuneWheel) {
    for (const btn of this.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
      btn.onclick = () => this.setTab(btn.dataset.tab as ShopTab);
    }
    this.closeBtn.onclick = () => this.wheel.close();
    this.couponBtn.onclick = () => {
      this.actions?.toggleCoupon();
      this.render();
    };
    window.addEventListener("keydown", (e) => {
      if (!this.actions || !this.wheel.isTop || e.repeat) return;
      if (e.code === "Digit1") this.setTab("wheel");
      else if (e.code === "Digit2") this.setTab("shop");
      else if (e.code === "Digit3") this.setTab("craft");
    });
  }

  get isOpen(): boolean {
    return this.actions !== null;
  }

  /** Вызывается вместе с wheel.open — вкладки живут поверх того же оверлея */
  open(actions: ShopActions, tab: ShopTab = "wheel"): void {
    this.actions = actions;
    this.msgEl.textContent = "";
    this.setTab(tab);
  }

  close(): void {
    this.actions = null;
    this.wheel.keysEnabled = true;
  }

  setTab(tab: ShopTab): void {
    if (this.wheel.isSpinning) return;
    this.tab = tab;
    for (const [name, el] of Object.entries(this.panels)) el.style.display = name === tab ? "flex" : "none";
    for (const btn of this.tabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    // Пробел на вкладке магазина не должен крутить колесо
    this.wheel.keysEnabled = tab === "wheel";
    this.render();
  }

  /** Перерисовать золото и активную вкладку */
  render(): void {
    const a = this.actions;
    if (!a) return;
    this.goldEl.textContent = `Золото: ${a.host.player.gold}`;
    if (this.tab === "shop") this.renderShop(a);
    else if (this.tab === "craft") this.renderCraft(a);
  }

  private say(text: string, err = false): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.toggle("err", err);
  }

  private priceHtml(a: ShopActions, base: number, verb: string): string {
    const p = a.price(base);
    return p !== base ? `${verb} за <s>${base}</s>${p}` : `${verb} за ${base}`;
  }

  private renderShop(a: ShopActions): void {
    const gold = a.host.player.gold;
    const coupons = a.host.coupons;
    this.couponBtn.disabled = coupons === 0;
    this.couponBtn.classList.toggle("on", a.couponMode);
    this.couponBtn.textContent =
      coupons === 0 ? "Купонов нет" : a.couponMode ? `Купон: −50 % на покупку (осталось ${coupons})` : `Использовать купон (${coupons}) — −50 %`;

    const { items, weapon } = a.stock();
    this.stockEl.innerHTML = "";
    if (!items.length && !weapon) this.stockEl.innerHTML = `<div class="shopEmpty">Распродано — новый товар на следующем этапе</div>`;
    for (const it of items) {
      const price = a.price(it.price);
      this.stockEl.appendChild(
        this.card(it.title, it.desc, this.priceHtml(a, it.price, "Купить"), gold >= price, () => {
          if (a.buyItem(it)) this.say(`Куплено: ${it.title}`);
          else this.say("Не хватает золота", true);
          this.render();
        }),
      );
    }
    if (weapon) {
      const price = a.price(weapon.price);
      this.stockEl.appendChild(
        this.card(weapon.title, weapon.desc, this.priceHtml(a, weapon.price, "Купить"), gold >= price, () => {
          if (a.buyWeapon(weapon)) this.say(`Куплено: ${weapon.title}`);
          else this.say("Не хватает золота", true);
          this.render();
        }),
      );
    }

    this.sellEl.innerHTML = "";
    const owned = a.host.weapons.owned;
    if (!owned.length) this.sellEl.innerHTML = `<div class="shopEmpty">Пока ничего: выиграйте на колесе или купите</div>`;
    owned.forEach((id, i) => {
      const title = a.host.weapons.ownedTitles[i];
      const price = a.host.weapons.sellPrice(id);
      const card = this.card(title, "Продать за половину цены — освободить место под другой билд", `Продать за ${price}`, true, () => {
        a.sellWeapon(id);
        this.say(`Продано: ${title} (+${price})`);
        this.render();
      });
      card.querySelector("button")!.classList.add("sell");
      this.sellEl.appendChild(card);
    });
  }

  private renderCraft(a: ShopActions): void {
    const host = a.host;
    const recipes = visibleRecipes(host);
    this.craftEl.innerHTML = "";
    if (!recipes.length) {
      this.craftEl.innerHTML = `<div class="shopEmpty">Все доступные рецепты уже собраны</div>`;
      return;
    }
    for (const r of recipes) {
      const ok = canCraft(host, r);
      const card = this.card(r.title, r.desc, `Скрафтить за ${r.gold}`, ok, () => {
        if (a.craft(r)) this.say(`Скрафчено: ${r.title}`);
        else this.say("Не хватает ингредиентов или золота", true);
        this.render();
      });
      const list = document.createElement("ul");
      if (r.onlyWeapon) list.innerHTML += `<li class="have">${r.onlyWeapon === "gun" ? "Пистолет" : "Меч"} в руке</li>`;
      for (const ing of r.needs) {
        list.innerHTML += `<li class="${hasIngredient(host, ing) ? "have" : ""}">${ingredientTitle(ing)}</li>`;
      }
      list.innerHTML += `<li class="${host.player.gold >= r.gold ? "have" : ""}">${r.gold} золота</li>`;
      card.insertBefore(list, card.querySelector("button"));
      card.classList.toggle("ok", ok);
      this.craftEl.appendChild(card);
    }
  }

  private card(title: string, desc: string, btnHtml: string, enabled: boolean, onClick: () => void): HTMLElement {
    const card = document.createElement("div");
    card.className = "shopCard";
    card.innerHTML = `<h4>${title}</h4><p>${desc}</p>`;
    const btn = document.createElement("button");
    btn.className = "buy";
    btn.innerHTML = btnHtml;
    btn.disabled = !enabled;
    btn.onclick = onClick;
    card.appendChild(btn);
    return card;
  }
}
