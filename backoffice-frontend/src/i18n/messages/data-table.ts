export const en = {
  navigation: '{caption} pagination',
  range: '{first}–{last} of {total}',
  page: 'Page {page} of {pages}',
  previous: 'Previous',
  next: 'Next',
  previousPage: 'Previous page',
  nextPage: 'Next page',
};

export const it = {
  navigation: 'Paginazione: {caption}',
  range: '{first}–{last} di {total}',
  page: 'Pagina {page} di {pages}',
  previous: 'Precedente',
  next: 'Successiva',
  previousPage: 'Pagina precedente',
  nextPage: 'Pagina successiva',
} satisfies Record<keyof typeof en, string>;

export const ru = {
  navigation: 'Страницы таблицы «{caption}»',
  range: '{first}–{last} из {total}',
  page: 'Страница {page} из {pages}',
  previous: 'Назад',
  next: 'Далее',
  previousPage: 'Предыдущая страница',
  nextPage: 'Следующая страница',
} satisfies Record<keyof typeof en, string>;

export const uz = {
  navigation: '{caption} sahifalari',
  range: '{total} tadan {first}–{last}',
  page: '{pages} sahifadan {page}-sahifa',
  previous: 'Oldingi',
  next: 'Keyingi',
  previousPage: 'Oldingi sahifa',
  nextPage: 'Keyingi sahifa',
} satisfies Record<keyof typeof en, string>;
