import React, { createContext, useContext, useState } from 'react';
import { loadSavedLocale, saveLocalePreference } from '../platform';
import { en } from './en';
import { tr } from './tr';
import { type ITranslations, type Locale } from './types';

const dictionaries: Record<Locale, ITranslations> = { tr, en };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: ITranslations;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider: React.FC<{
  defaultLocale?: Locale;
  children: React.ReactNode;
}> = ({ defaultLocale = 'tr', children }) => {
  const [locale, setLocaleState] = useState<Locale>(
    () => loadSavedLocale() ?? defaultLocale
  );

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    saveLocalePreference(next);
  };

  const toggleLocale = () => {
    setLocale(locale === 'tr' ? 'en' : 'tr');
  };

  return (
    <I18nContext.Provider
      value={{
        locale,
        setLocale,
        toggleLocale,
        t: dictionaries[locale],
      }}
    >
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return ctx;
}

export * from './types';
