import { useId, useState, type KeyboardEvent } from 'react';
import { joinCities, splitCities } from '../../domain/v2/cities.js';
import './city-tags.css';

const MAX_SUGGESTIONS = 6;

export interface CityTagsInputProps {
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly string[];
  label: string;
  autoFocus?: boolean;
  /** Reports the text typed but not yet turned into a tag, so a host can include it when it saves. */
  onDraftChange?: (draft: string) => void;
  /** Enter on an empty input: the host's chance to finish editing. */
  onSubmit?: () => void;
  /** Esc with no suggestion list open: the host's chance to cancel editing. */
  onCancel?: () => void;
  /** Shows the suggestions in the page flow instead of floating over it (for use inside scrolling tables). */
  inlineMenu?: boolean;
}

/**
 * Edits the stored city text as one tag per city. Enter, comma or 、 adds the
 * typed city; Backspace on an empty input removes the last tag.
 *
 * Suggestions come from the cities already used. They appear only while something is
 * typed, and close on Esc, selection, losing focus or unmounting, because they are
 * drawn by the page rather than by the browser (a native datalist can't be closed).
 */
export function CityTagsInput({ value, onChange, suggestions, label, autoFocus, onDraftChange, onSubmit, onCancel, inlineMenu }: CityTagsInputProps) {
  const [draft, setDraftState] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const menuId = useId();
  const tags = splitCities(value);
  const needle = draft.trim().toLocaleLowerCase();
  const matches = needle
    ? suggestions.filter(city => !tags.includes(city) && city.toLocaleLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS)
    : [];
  const showMenu = open && matches.length > 0;

  const setDraft = (next: string) => { setDraftState(next); onDraftChange?.(next); };
  const add = (text: string) => {
    const next = joinCities([...tags, ...splitCities(text)]);
    if (next !== value) onChange(next);
    setDraft('');
    setOpen(false);
    setActive(-1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!matches.length) return;
      event.preventDefault();
      setOpen(true);
      setActive(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Escape') {
      if (showMenu) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
      else if (onCancel) { event.preventDefault(); event.stopPropagation(); onCancel(); }
    } else if (event.key === 'Enter' && showMenu && active >= 0) {
      event.preventDefault();
      add(matches[active]!);
    } else if ((event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') && draft.trim()) {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit?.();
    } else if (event.key === 'Backspace' && !draft && tags.length) {
      onChange(joinCities(tags.slice(0, -1)));
    }
  };
  return <div className={`city-tags${inlineMenu ? ' city-tags--inline-menu' : ''}`}>
    {tags.map(city => <span key={city} className="city-tags__tag">{city}<button type="button" aria-label={`移除${city}`} onClick={() => onChange(joinCities(tags.filter(item => item !== city)))}>×</button></span>)}
    <input
      aria-label={label}
      role="combobox"
      aria-expanded={showMenu}
      aria-controls={menuId}
      aria-autocomplete="list"
      {...(showMenu && active >= 0 ? { 'aria-activedescendant': `${menuId}-${active}` } : {})}
      autoComplete="off"
      {...(autoFocus ? { autoFocus: true } : {})}
      value={draft}
      placeholder={tags.length ? '再加一个城市' : '输入城市后按回车，如：上海'}
      onChange={event => {
        // Pasting "北京、上海" adds tags at once.
        const next = event.target.value;
        if (/[、,，/／;；]/u.test(next)) { add(next); return; }
        setDraft(next);
        setOpen(true);
        setActive(-1);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => { setOpen(false); setActive(-1); if (draft.trim()) add(draft); }}
    />
    {showMenu && <ul id={menuId} className="city-tags__menu" role="listbox" aria-label={`${label}的建议`}>
      {matches.map((city, index) => <li
        key={city}
        id={`${menuId}-${index}`}
        role="option"
        aria-selected={index === active}
        className={index === active ? 'is-active' : undefined}
        // mousedown (not click) with preventDefault keeps focus in the input, so the blur above doesn't race the pick.
        onMouseDown={event => { event.preventDefault(); add(city); }}
        onMouseEnter={() => setActive(index)}
      >{city}</li>)}
    </ul>}
  </div>;
}
