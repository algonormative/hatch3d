/** The id rule shared by pens, controls, parts and assembly plies: a letter, then letters, digits, `_` or `-`. */
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
