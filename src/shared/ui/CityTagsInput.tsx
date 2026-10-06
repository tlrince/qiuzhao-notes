import { useId, useState, type KeyboardEvent } from 'react';
import { joinCities, splitCities } from '../../domain/v2/cities.js';
import './city-tags.css';

/**
 * Edits the stored city text as one tag per city. Enter, comma or 、 adds the
 * typed city; Backspace on an empty input removes the last tag.
 */
export function CityTagsInput({ value, onChange, suggestions, label }: { value: string; onChange: (value: string) => void; suggestions: readonly string[]; label: string }) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const tags = splitCities(value);
  const add = (text: string) => {
    const next = joinCities([...tags, ...splitCities(text)]);
    if (next !== value) onChange(next);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') && draft.trim()) {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Enter') {
      event.preventDefault();
    } else if (event.key === 'Backspace' && !draft && tags.length) {
      onChange(joinCities(tags.slice(0, -1)));
    }
  };
  return <div className="city-tags">
    {tags.map(city => <span key={city} className="city-tags__tag">{city}<button type="button" aria-label={`移除${city}`} onClick={() => onChange(joinCities(tags.filter(item => item !== city)))}>×</button></span>)}
    <input
      aria-label={label}
      list={listId}
      value={draft}
      placeholder={tags.length ? '再加一个城市' : '输入城市后按回车，如：上海'}
      onChange={event => {
        // Picking from the suggestion list or pasting "北京、上海" adds tags at once.
        const next = event.target.value;
        if (suggestions.includes(next.trim()) || /[、,，/／;；]/u.test(next)) add(next);
        else setDraft(next);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => { if (draft.trim()) add(draft); }}
    />
    <datalist id={listId}>{suggestions.filter(city => !tags.includes(city)).map(city => <option key={city} value={city} />)}</datalist>
  </div>;
}
