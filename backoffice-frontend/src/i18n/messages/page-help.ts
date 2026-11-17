import type { View, WorkspaceSection } from '@/lib/contracts';

export type PageHelpTopic =
  | View
  | Exclude<WorkspaceSection, 'deliveries' | 'directory'>
  | 'deliveryDetails'
  | 'participantCalendar'
  | 'crews'
  | 'participants'
  | 'templates'
  | 'participantSkills'
  | 'login';

type PageHelpMessages = Record<PageHelpTopic | 'label', string>;

export const en = {
  planning: 'Maintain shared participant shifts, breaks and absences, departure and return locations, and agreed work-time standards. Changes preserve history; published routes and applied line estimates keep their recorded versions.',
  decisions: 'Review source changes, missing map points, Issues, evidence and warehouse follow-ups. Assign a coordinator and next action, then open the original record to resolve the cause. Cases close automatically when that cause is resolved.',
  label: 'About {title}',
  routes: 'Draft a route with stops from different pickings and find remaining work nearby. Change the stop order or work duration to recalculate estimated arrivals and the return time.',
  calendar: 'See scheduled visits and their crews by day, week or month. Select a visit to open its delivery.',
  staffing: 'Choose a date to see who is assigned to each booked visit. Edit staffing to check availability and change the people assigned to that visit.',
  imports: 'Run a read-only import from the demo Odoo database and check the result. Open the run details to investigate warnings or errors.',
  skills: "Manage the skills catalog used for task requirements and participant qualifications. Administrators and operators can add, edit, disable or delete unused skills and assign skills to participants.",
  vehicles: 'Administrators and operators can create, edit, disable or delete unused company and external vehicles. To reserve a vehicle, open the booked visit in the delivery details.',
  deliveryDetails: 'Check the address, instructions and remaining work. Use the tabs to plan visits, handle issues and returns, or review evidence and history.',
  participantCalendar: 'See this participant’s assigned visits and tasks by day, week or month. Select a visit to open its delivery.',
  crews: "Create, view and edit default crews and their members, or delete unused crews. Open a participant’s calendar from their name, or use Visit staffing to change the people on a specific visit.",
  participants: "Create and manage participant profiles, contacts, skills and Crew sign-in access. Open a participant’s calendar to see scheduled visits and tasks. Used profiles can be disabled; unused profiles can be deleted.",
  templates: "Create and manage reusable task templates, including checklists and required skills. Delete unused templates or disable previously used ones. Select a template when assigning work on a visit.",
  participantSkills: "See which skills each participant has. Administrators and operators can update these skills to match the work a participant is qualified to do.",
  login: 'Sign in with a Backoffice administrator or operator account. You can choose your language before signing in.',
  inbox: 'Filter by city, province or postal code (CAP), including missing values. Switch to Map to see all matching deliveries, then open a point to view its delivery and Nearby work. Numbered points contain several deliveries; those without coordinates appear below. Select nearby work to create a draft and review it in Routes before booking visits.',
  planned: 'These deliveries have a booked visit waiting for a crew. Open a delivery to assign crews and tasks.',
  assigned: 'These deliveries have a booked visit with a crew assigned. Open the visit to check staffing and record the customer’s confirmation once they agree.',
  in_progress: 'These deliveries have a visit under way. Open a delivery to check visit details or review the crew’s report in History after the visit.',
  partially_completed: 'Find deliveries with recorded work that are still open. Check the remaining quantities and tasks, then plan a follow-up or complete the delivery once it is ready.',
  return_required: 'Find deliveries with an unresolved return request. Review the remaining work and book a return visit if one is still needed.',
  issues: 'Find deliveries with an open issue. Open Issues & returns to review the details and record a resolution.',
  completed: 'Review closed deliveries. Open History to see results, evidence and the record of completion.',
} satisfies PageHelpMessages;

export const it = {
  planning: 'Gestisci turni, pause, assenze, luoghi di partenza e rientro e standard dei tempi concordati. Le modifiche conservano la cronologia; giri pubblicati e tempi applicati alle righe mantengono le versioni registrate.',
  decisions: 'Controlla modifiche della fonte, punti mappa mancanti, Problemi, prove e attività di magazzino. Assegna coordinatore e prossima azione, poi apri il documento originale. I casi si chiudono automaticamente quando la causa è risolta.',
  label: 'Informazioni su {title}',
  routes: 'Crea una bozza di percorso con tappe di più picking e trova le attività rimanenti nelle vicinanze. Cambia l’ordine delle tappe o la durata del lavoro per ricalcolare gli arrivi e il rientro.',
  calendar: 'Consulta le visite programmate e le squadre assegnate per giorno, settimana o mese. Seleziona una visita per aprire la relativa consegna.',
  staffing: 'Scegli una data per vedere chi è assegnato a ogni visita prenotata. Modifica il personale per verificare la disponibilità e cambiare le persone assegnate alla visita.',
  imports: 'Avvia un’importazione in sola lettura dal database Odoo di prova e controllane l’esito. Apri i dettagli dell’importazione per verificare avvisi o errori.',
  skills: "Gestisci le competenze usate per i requisiti delle attività e le qualifiche dei partecipanti. Amministratori e operatori possono aggiungere, modificare, disattivare o eliminare le competenze inutilizzate e assegnarle ai partecipanti.",
  vehicles: 'Amministratori e operatori possono creare, modificare, disattivare o eliminare i veicoli aziendali ed esterni inutilizzati. Per prenotare un veicolo, apri la visita prenotata nei dettagli della consegna.',
  deliveryDetails: 'Controlla indirizzo, istruzioni e lavoro rimanente. Usa le schede per pianificare visite, gestire problemi e nuovi interventi oppure consultare prove e cronologia.',
  participantCalendar: 'Consulta le visite e le attività assegnate al partecipante per giorno, settimana o mese. Seleziona una visita per aprire la relativa consegna.',
  crews: "Crea, consulta e modifica le squadre predefinite e i loro membri oppure elimina le squadre inutilizzate. Apri il calendario dal nome di un partecipante o usa Personale per le visite per cambiare il personale di una visita.",
  participants: "Crea e gestisci profili, recapiti, competenze e accesso Crew dei partecipanti. Apri il calendario per vedere visite e attività. I profili utilizzati possono essere disattivati; quelli inutilizzati possono essere eliminati.",
  templates: "Crea e gestisci modelli di attività con liste di controllo e competenze richieste. Elimina i modelli inutilizzati o disattiva quelli già usati. Seleziona un modello quando assegni il lavoro a una visita.",
  participantSkills: "Controlla le competenze di ogni partecipante. Amministratori e operatori possono aggiornarle in base alle attività per cui il partecipante è qualificato.",
  login: 'Accedi con un account di amministratore o operatore Backoffice. Puoi scegliere la lingua prima di accedere.',
  inbox: 'Filtra per città, provincia o CAP, inclusi i valori mancanti. Passa a Mappa per vedere tutte le consegne corrispondenti e apri un punto per vedere la consegna e i lavori vicini. I punti numerati contengono più consegne; quelle senza coordinate appaiono sotto. Seleziona i lavori vicini per creare una bozza e verificala in Percorsi prima di prenotare visite.',
  planned: 'Queste consegne hanno una visita prenotata in attesa di una squadra. Apri una consegna per assegnare squadre e attività.',
  assigned: 'Queste consegne hanno una visita prenotata con una squadra assegnata. Apri la visita per controllare il personale e registra la conferma quando il cliente accetta.',
  in_progress: 'Queste consegne hanno una visita in corso. Apri una consegna per vedere i dettagli della visita o consulta il rapporto della squadra nella cronologia al termine.',
  partially_completed: 'Trova le consegne ancora aperte con lavoro già registrato. Controlla quantità e attività rimanenti, poi pianifica un nuovo intervento o chiudi la consegna quando è pronta.',
  return_required: 'Trova le consegne con una richiesta di nuovo intervento ancora aperta. Controlla il lavoro rimanente e prenota una visita se serve.',
  issues: 'Trova le consegne con un problema aperto. Apri la scheda dei problemi per controllare i dettagli e registrare la soluzione.',
  completed: 'Consulta le consegne chiuse. Apri la cronologia per vedere i risultati, le prove e la registrazione del completamento.',
} satisfies PageHelpMessages;

export const ru = {
  planning: 'Ведите общие смены, перерывы и отсутствия, точки выезда и возврата и согласованные нормы времени. Изменения сохраняют историю; опубликованные рейсы и применённые к позициям нормы сохраняют записанные версии.',
  decisions: 'Проверяйте изменения источника, отсутствующие точки карты, Issues, доказательства и складские действия. Назначьте координатора и следующий шаг, затем откройте исходную запись. Случай закроется автоматически после устранения причины.',
  label: 'О разделе «{title}»',
  routes: 'Соберите черновик рейса из адресов разных Picking и найдите работы поблизости. Меняйте порядок остановок или длительность работ, чтобы пересчитать время прибытия и возврата.',
  calendar: 'Смотрите запланированные визиты и назначенные бригады по дням, неделям или месяцам. Выберите визит, чтобы открыть карточку доставки.',
  staffing: 'Выберите дату, чтобы увидеть участников каждого забронированного визита. Откройте редактор состава, чтобы проверить доступность людей и изменить назначения для этого визита.',
  imports: 'Запустите импорт из учебной базы Odoo в режиме чтения и проверьте результат. Откройте детали запуска, чтобы разобраться с предупреждениями или ошибками.',
  skills: "Управляйте навыками для требований к задачам и квалификаций участников. Администраторы и операторы могут добавлять, редактировать, отключать и удалять неиспользованные навыки, а также назначать навыки участникам.",
  vehicles: 'Администраторы и операторы могут создавать, редактировать, отключать и удалять неиспользованный транспорт компании и подрядчиков. Чтобы забронировать машину, откройте забронированный визит в карточке доставки.',
  deliveryDetails: 'Проверьте адрес, инструкции и оставшиеся работы. На вкладках можно планировать визиты, разбирать проблемы и повторные выезды, смотреть доказательства и историю.',
  participantCalendar: 'Смотрите назначенные визиты и задачи участника по дням, неделям или месяцам. Выберите визит, чтобы открыть карточку доставки.',
  crews: "Создавайте, просматривайте и редактируйте бригады и их постоянный состав, удаляйте неиспользованные бригады. Нажмите на имя участника, чтобы открыть календарь. Для состава конкретного визита используйте «Составы выездов».",
  participants: "Создавайте и редактируйте профили, контакты, навыки и доступ участников к Crew. В календаре участника видны визиты и задачи. Использованные профили можно отключить, а неиспользованные — удалить.",
  templates: "Создавайте и редактируйте шаблоны задач с чек-листами и требованиями к навыкам. Неиспользованные шаблоны можно удалить, ранее использованные — отключить. Выбирайте шаблон при назначении работы на визит.",
  participantSkills: "Смотрите, какими навыками владеет каждый участник. Администраторы и операторы могут обновлять навыки с учётом работ, которые участник может выполнить.",
  login: 'Войдите с учётной записью администратора или оператора Backoffice. Язык можно выбрать до входа.',
  inbox: 'Фильтруйте по городу, провинции или индексу (CAP), включая отсутствующие значения. Переключитесь на карту и откройте точку, чтобы увидеть доставку и ближайшие работы. Точки с числом объединяют несколько доставок; записи без координат показаны ниже. Выберите работы рядом для черновика и проверьте его в «Маршрутах» перед бронированием визитов.',
  planned: 'У этих доставок уже есть забронированный визит, которому нужна бригада. Откройте карточку, чтобы назначить бригады и задачи.',
  assigned: 'На забронированный визит этих доставок назначена бригада. Откройте визит, проверьте состав и зафиксируйте подтверждение клиента после согласования.',
  in_progress: 'По этим доставкам уже начался визит. Откройте карточку, чтобы проверить детали визита, или посмотрите отчёт бригады в истории после завершения.',
  partially_completed: 'Найдите открытые доставки, по которым уже записана работа. Проверьте остатки и задачи, затем запланируйте повторный визит или закройте доставку, когда она будет готова.',
  return_required: 'Найдите доставки с открытым запросом на повторный визит. Проверьте оставшиеся работы и забронируйте визит, если он ещё нужен.',
  issues: 'Найдите доставки с открытой проблемой. Откройте вкладку проблем, чтобы проверить детали и зафиксировать решение.',
  completed: 'Смотрите закрытые доставки. В истории доступны результаты, доказательства и запись о завершении.',
} satisfies PageHelpMessages;

export const uz = {
  planning: 'Umumiy smena, tanaffus, yo‘qlik, chiqish va qaytish joylari hamda kelishilgan vaqt me’yorlarini boshqaring. O‘zgarishlar tarixni saqlaydi; e’lon qilingan reys va qo‘llangan vaqtlar qayd etilgan versiyani saqlaydi.',
  decisions: 'Manba o‘zgarishlari, xaritada yo‘q manzillar, muammolar, dalillar va ombor ishlarini ko‘ring. Muvofiqlashtiruvchi va keyingi amalni belgilang, so‘ng asl yozuvni oching. Sabab bartaraf etilganda holat avtomatik yopiladi.',
  label: '{title} haqida',
  routes: 'Turli Picking manzillaridan marshrut qoralamasini tuzing va yaqin atrofdagi qolgan ishlarni toping. Bekatlar tartibini yoki ish davomiyligini o‘zgartirsangiz, yetib borish va qaytish vaqtlari qayta hisoblanadi.',
  calendar: 'Rejalashtirilgan tashriflar va tayinlangan brigadalarni kun, hafta yoki oy bo‘yicha ko‘ring. Yetkazmani ochish uchun tashrifni tanlang.',
  staffing: 'Band qilingan har bir tashrifga kim tayinlanganini ko‘rish uchun sanani tanlang. Xodimlarning bo‘sh vaqtini tekshirish va tayinlovni o‘zgartirish uchun tashrif tarkibini tahrirlang.',
  imports: 'Sinov Odoo bazasidan faqat o‘qish rejimida importni ishga tushiring va natijani tekshiring. Ogohlantirish yoki xatolarni ko‘rish uchun import tafsilotlarini oching.',
  skills: "Vazifa talablari va ishtirokchilar malakasi uchun ko‘nikmalarni boshqaring. Administratorlar va operatorlar ko‘nikmalarni qo‘shishi, tahrirlashi, faolsizlantirishi, ishlatilmaganlarini o‘chirishi va ishtirokchilarga tayinlashi mumkin.",
  vehicles: 'Administratorlar va operatorlar korxona va tashqi transportni qo‘shishi, tahrirlashi, faolsizlantirishi yoki ishlatilmaganlarini o‘chirishi mumkin. Transportni band qilish uchun yetkazma tafsilotlarida band qilingan tashrifni oching.',
  deliveryDetails: 'Manzil, ko‘rsatmalar va qolgan ishlarni tekshiring. Bo‘limlarda tashriflarni rejalashtirish, muammolar va takroriy tashriflarni boshqarish, dalillar va tarixni ko‘rish mumkin.',
  participantCalendar: 'Ishtirokchiga tayinlangan tashrif va vazifalarni kun, hafta yoki oy bo‘yicha ko‘ring. Yetkazmani ochish uchun tashrifni tanlang.',
  crews: "Brigadalar va ularning doimiy tarkibini yarating, ko‘ring va tahrirlang yoki ishlatilmagan brigadalarni o‘chiring. Ishtirokchi nomidan taqvimni oching. Muayyan tashrif tarkibini o‘zgartirish uchun «Tashrif tarkibi»dan foydalaning.",
  participants: "Ishtirokchilar profili, aloqa ma’lumotlari, ko‘nikmalari va Crew kirishini yarating va boshqaring. Taqvimda tashriflar va vazifalarni ko‘ring. Ishlatilgan profillarni faolsizlantirish, ishlatilmaganlarini o‘chirish mumkin.",
  templates: "Tekshiruv ro‘yxatlari va kerakli ko‘nikmalar bilan vazifa shablonlarini yarating va boshqaring. Ishlatilmagan shablonlarni o‘chiring yoki avval ishlatilganlarini faolsizlantiring. Tashrifga ish tayinlashda shablon tanlang.",
  participantSkills: "Har bir ishtirokchining ko‘nikmalarini ko‘ring. Administratorlar va operatorlar ularni ishtirokchi bajara oladigan ishlarga moslab yangilashi mumkin.",
  login: 'Backoffice administrator yoki operator hisobi orqali kiring. Tilni kirishdan oldin tanlashingiz mumkin.',
  inbox: 'Shahar, viloyat yoki indeks (CAP), jumladan yetishmayotgan qiymatlar bo‘yicha filtrlang. Xaritaga o‘tib, nuqtani oching: yetkazib berish va yaqin ishlar ko‘rinadi. Raqamli nuqtalarda bir nechta yetkazib berish bor; koordinatasizlari pastda ko‘rsatiladi. Yaqin ishlarni qoralamaga tanlang va tashrif band qilishdan oldin Marshrutlarda tekshiring.',
  planned: 'Bu yetkazmalarda tashrif band qilingan va brigada tayinlanishi kerak. Brigada va vazifalarni tayinlash uchun yetkazmani oching.',
  assigned: 'Bu yetkazmalarda band qilingan tashrifga brigada tayinlangan. Tashrifni ochib, tarkibni tekshiring va mijoz rozi bo‘lgach, tasdiqni qayd eting.',
  in_progress: 'Bu yetkazmalarda tashrif boshlangan. Tafsilotlarni ko‘rish uchun yetkazmani oching yoki tashrif tugagach, brigada hisobotini tarixda ko‘ring.',
  partially_completed: 'Ishlar qayd etilgan, ammo hali yopilmagan yetkazmalarni toping. Qolgan miqdorlar va vazifalarni tekshirib, takroriy tashrifni rejalashtiring yoki yetkazma tayyor bo‘lganda uni yoping.',
  return_required: 'Takroriy tashrif so‘rovi ochiq qolgan yetkazmalarni toping. Qolgan ishlarni tekshiring va kerak bo‘lsa, takroriy tashrifni band qiling.',
  issues: 'Ochiq muammosi bor yetkazmalarni toping. Tafsilotlarni tekshirish va yechimni qayd etish uchun muammolar bo‘limini oching.',
  completed: 'Yopilgan yetkazmalarni ko‘ring. Natijalar, dalillar va yakunlanganlik qaydini ko‘rish uchun tarixni oching.',
} satisfies PageHelpMessages;
