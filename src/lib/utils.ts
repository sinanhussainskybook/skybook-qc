import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine CSS class names. Later Tailwind classes win over earlier ones,
 * so a component's default `px-2` can be overridden by a caller's `px-4`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
