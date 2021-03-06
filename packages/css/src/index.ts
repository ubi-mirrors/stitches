import { AllCssProps } from "./css-types";
import {
  IAtom,
  IComposedAtom,
  IConfig,
  ICssPropToToken,
  IScreens,
  ISheet,
  ITokensDefinition,
  TCss,
  TUtilityFirstCss,
} from "./types";
import { addDefaultUtils, createSheets, cssPropToToken } from "./utils";

export * from "./types";
export * from "./css-types";

// tslint:disable-next-line: no-empty
const noop = () => {};

export const hotReloadingCache = new Map<string, any>();

const toCssProp = (cssPropParts: string[]) => {
  return cssPropParts.join("-");
};

const toStringCachedAtom = function (this: IAtom) {
  return this._className!;
};

const toStringCompose = function (this: IComposedAtom) {
  const className = this.atoms.map((atom) => atom.toString()).join(" ");

  // cache the className on this instance
  // @ts-ignore
  this._className = className;
  // @ts-ignore
  this.toString = toStringCachedAtom;
  return className;
};

const createToString = (
  sheets: { [screen: string]: ISheet },
  screens: IScreens = {},
  cssClassnameProvider: (seq: number, atom: IAtom) => [string, string?], // [className, pseudo]
  startSeq = 0
) => {
  let seq = startSeq;
  return function toString(this: IAtom) {
    const className = cssClassnameProvider(seq++, this);

    const cssProp = toCssProp(this.cssPropParts);
    const value = this.value;

    let cssRule = "";
    if (className.length === 2) {
      cssRule = `.${className[0]}${className[1]}{${cssProp}:${value};}`;
    } else {
      cssRule = `.${className[0]}{${cssProp}:${value};}`;
    }

    sheets[this.screen].insertRule(
      this.screen ? screens[this.screen](cssRule) : cssRule
    );

    // We are switching this atom from IAtom simpler representation
    // 1. delete everything but `id` for specificity check

    // @ts-ignore
    this.cssPropParts = this.value = this.pseudo = this.screen = undefined;

    // 2. put on a _className
    this._className = className[0];

    // 3. switch from this `toString` to a much simpler one
    this.toString = toStringCachedAtom;

    return className[0];
  };
};

const composeIntoMap = (
  map: Map<string, IAtom>,
  atoms: (IAtom | IComposedAtom)[]
) => {
  let i = atoms.length - 1;
  for (; i >= 0; i--) {
    const item = atoms[i];
    // atoms can be undefined, null, false or '' using ternary like
    // expressions with the properties
    if (item && "atoms" in item) {
      composeIntoMap(map, item.atoms);
    } else if (item) {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    }
  }
};

export const createConfig = <T extends IConfig>(config: T) => {
  return config;
};

export const createTokens = <T extends ITokensDefinition>(tokens: T) => {
  return tokens;
};

export const createCss = <T extends IConfig>(
  config: T,
  env: Window | null = typeof window === "undefined" ? null : window
): T extends { utilityFirst: true } ? TUtilityFirstCss<T> : TCss<T> => {
  const prefix = config.prefix || "";

  if (env && hotReloadingCache.has(prefix)) {
    return hotReloadingCache.get(prefix);
  }

  // pre-compute class prefix
  const classPrefix = prefix ? `${prefix}_` : "";
  const cssClassnameProvider = (
    seq: number,
    atom: IAtom
  ): [string, string?] => {
    const className = `${classPrefix}${
      atom.screen ? `${atom.screen}_` : ""
    }${atom.cssPropParts.map((part) => part[0]).join("")}_${seq}`;

    if (atom.pseudo) {
      return [className, atom.pseudo];
    }

    return [className];
  };
  const sheets = createSheets(env, config.screens);
  const startSeq = Object.keys(sheets).reduce((count, key) => {
    // Can fail with cross origin (like Codesandbox)
    try {
      return count + sheets[key].cssRules.length;
    } catch {
      return count;
    }
  }, 0);
  const toString = createToString(
    sheets,
    config.screens,
    cssClassnameProvider,
    startSeq
  );
  const compose = (...atoms: IAtom[]): IComposedAtom => {
    const map = new Map<string, IAtom>();
    composeIntoMap(map, atoms);
    return {
      atoms: Array.from(map.values()),
      toString: toStringCompose,
    };
  };

  addDefaultUtils(config);

  // pre-checked config to avoid checking these all the time
  const screens = config.screens || {};
  const utils = config.utils || {};
  const tokens = config.tokens || {};

  // atom cache
  const atomCache = new Map<string, IAtom>();

  // proxy state values that change based on propertie access
  let cssProp = "";
  let screen = "";
  // We need to know when we call utils to avoid clearing
  // the screen set for that util, also avoid util calling util
  // when overriding properties
  let isCallingUtil = false;
  // We need to know when we override as it does not require a util to
  // be called
  let isOverriding = false;

  const cssInstance = new Proxy(noop, {
    get(_, prop, proxy) {
      if (prop === "compose") {
        return compose;
      }
      // SSR
      if (prop === "getStyles") {
        return () =>
          Object.keys(screens).reduce(
            (aggr, key) => {
              return aggr.concat(
                `/* STITCHES:${key} */\n${sheets[key].content}`
              );
            },
            [`/* STITCHES */\n${sheets[""].content}`]
          );
      }

      if (prop === "override" && config.utilityFirst) {
        isOverriding = true;
        return proxy;
      }

      if (prop in screens) {
        screen = String(prop);
      } else if (!isCallingUtil && prop in utils) {
        const util = utils[String(prop)](proxy, config);
        return (...args: any[]) => {
          isCallingUtil = true;
          const result = util(...args);
          isCallingUtil = false;
          screen = "";
          return result;
        };
      } else if (config.utilityFirst && !isCallingUtil && !isOverriding) {
        throw new Error(
          `@stitches/css - The property "${String(prop)}" is not available`
        );
      } else {
        cssProp = String(prop);
      }

      return proxy;
    },
    apply(_, __, argsList) {
      const value = argsList[0];
      const pseudo = argsList[1];
      const token = tokens[cssPropToToken[cssProp as keyof ICssPropToToken]];

      // generate id used for specificity check
      // two atoms are considered equal in regared to there specificity if the id is equal
      const id =
        cssProp.toLowerCase() +
        (pseudo ? pseudo.split(":").sort().join(":") : "") +
        screen;

      // make a uid accouting for different values
      const uid = id + value;

      // If this was created before return the cached atom
      if (atomCache.has(uid)) {
        // Reset the screen name if needed
        if (!isCallingUtil) {
          screen = "";
        }
        return atomCache.get(uid)!;
      }

      // prepare the cssProp
      const cssPropParts = cssProp
        .split(/(?=[A-Z])/)
        .map((g) => g.toLowerCase());

      // Create a new atom
      const atom: IAtom = {
        id,
        cssPropParts,
        value: token ? token[value] : value,
        pseudo,
        screen,
        toString,
      };

      // Cache it
      atomCache.set(uid, atom);

      // Reset the screen name
      if (!isCallingUtil) {
        screen = "";
      }

      isOverriding = false;

      return atom;
    },
  }) as any;

  if (env) {
    hotReloadingCache.set(prefix, cssInstance);
  }

  return cssInstance;
};

// default instance
export const css = createCss({
  prefix: "di",
});
