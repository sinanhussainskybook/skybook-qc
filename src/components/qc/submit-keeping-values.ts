import { startTransition, type FormEvent } from "react";

/**
 * onSubmit for a form whose action may be refused (validation, an expired
 * session). React resets a `<form action={…}>` after every action, so a
 * refused save would wipe what the designer typed; submitting by hand keeps
 * the fields as they are. The server still checks everything.
 */
export function submitKeepingValues(formAction: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };
}
