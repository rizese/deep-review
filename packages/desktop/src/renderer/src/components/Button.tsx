import type { ButtonHTMLAttributes, JSX } from "react";
import styles from "./Button.module.css";

type ButtonVariant = "quiet" | "primary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** The small size sits inside a card's row of controls. */
  size?: "sm";
}

/**
 * The one button: a translucent pill in the bar's glass. Pages pick a
 * variant and a size and say nothing else about how it looks.
 */
export function Button({ variant = "quiet", size, className, type = "button", ...rest }: ButtonProps): JSX.Element {
  const classes = [styles.button, variant !== "quiet" ? styles[variant] : "", size ? styles[size] : "", className ?? ""].filter(Boolean).join(" ");
  return <button className={classes} type={type} {...rest} />;
}
