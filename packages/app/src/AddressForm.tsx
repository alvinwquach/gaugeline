import { useId, useState, type FormEvent } from "react";

/**
 * The address to check. A server refusal (a 400 with its sentence) is shown next to the field and
 * what was typed stays; the field is cleared only when the check has started.
 */
export function AddressForm({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (url: string) => Promise<void>;
  /** The demo checks nothing: the field and the button are there, switched off. */
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const fieldId = useId();
  const errorId = useId();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (posting || disabled) return;
    const url = value.trim();
    if (url === "") {
      setError("Enter an address, such as yoursite.com.");
      return;
    }
    setError(null);
    setPosting(true);
    try {
      await onSubmit(url);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The check could not be started.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <form className="address-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={fieldId}>Address to check</label>
      <div className="address-row">
        <input
          id={fieldId}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="yoursite.com"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" disabled={posting || disabled} aria-busy={posting ? true : undefined}>
          {posting ? "Checking..." : "Check"}
        </button>
      </div>
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
