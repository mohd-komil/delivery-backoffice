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
  label: 'About {title}',
  routes: 'Draft a route with stops from different pickings and find remaining work nearby. Change the stop order or work duration to recalculate estimated arrivals and the return time.',
  calendar: 'See scheduled visits and their crews by day, week or month. Select a visit to open its delivery.',
  staffing: 'Choose a date to see who is assigned to each booked visit. Edit staffing to check availability and change the people assigned to that visit.',
  imports: 'Run a read-only import from the demo Odoo database and check the result. Open the run details to investigate warnings or errors.',
  skills: 'Review the skills catalog used to set task requirements and participant qualifications. Administrators can add, edit or disable skills here.',
  vehicles: 'Check the status of company and external vehicles. To reserve a vehicle, open the booked visit in the delivery details.',
  deliveryDetails: 'Check the address, instructions and remaining work. Use the tabs to plan visits, handle issues and returns, or review evidence and history.',
  participantCalendar: 'See this participant’s assigned visits and tasks by day, week or month. Select a visit to open its delivery.',
  crews: 'Review the default teams and their members. Open a participant’s calendar from their name, or use Visit staffing to change the people on a specific visit.',
  participants: 'Look up participant profiles, contact details and skills. Open a participant’s calendar to see their scheduled visits and assigned tasks.',
  templates: 'Review reusable task templates, including checklists and required skills. Select a template when assigning work to a crew on a visit.',
  participantSkills: 'See which skills each participant has. Administrators can update these skills to match the work a participant is qualified to do.',
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
  label: 'Informazioni su {title}',
  routes: 'Crea una bozza di percorso con tappe di più picking e trova le attività rimanenti nelle vicinanze. Cambia l’ordine delle tappe o la durata del lavoro per ricalcolare gli arrivi e il rientro.',
  calendar: 'Consulta le visite programmate e le squadre assegnate per giorno, settimana o mese. Seleziona una visita per aprire la relativa consegna.',
  staffing: 'Scegli una data per vedere chi è assegnato a ogni visita prenotata. Modifica il personale per verificare la disponibilità e cambiare le persone assegnate alla visita.',
  imports: 'Avvia un’importazione in sola lettura dal database Odoo di prova e controllane l’esito. Apri i dettagli dell’importazione per verificare avvisi o errori.',
  skills: 'Consulta il catalogo delle competenze usate per definire i requisiti delle attività e le qualifiche dei partecipanti. Gli amministratori possono aggiungere, modificare o disattivare le competenze.',
  vehicles: 'Controlla lo stato dei veicoli aziendali ed esterni. Per prenotare un veicolo, apri la visita prenotata nei dettagli della consegna.',
  deliveryDetails: 'Controlla indirizzo, istruzioni e lavoro rimanente. Usa le schede per pianificare visite, gestire problemi e nuovi interventi oppure consultare prove e cronologia.',
  participantCalendar: 'Consulta le visite e le attività assegnate al partecipante per giorno, settimana o mese. Seleziona una visita per aprire la relativa consegna.',
  crews: 'Consulta le squadre predefinite e i loro membri. Seleziona il nome di un partecipante per aprire il calendario, oppure usa Personale per le visite per cambiare chi partecipa a una visita.',
  participants: 'Cerca i profili dei partecipanti, i recapiti e le competenze. Apri il calendario di un partecipante per vedere le visite programmate e le attività assegnate.',
  templates: 'Consulta i modelli riutilizzabili, con liste di controllo e competenze richieste. Scegli un modello quando assegni un’attività a una squadra per una visita.',
  participantSkills: 'Controlla le competenze di ogni partecipante. Gli amministratori possono aggiornarle in base alle attività per cui il partecipante è qualificato.',
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
  label: 'О разделе «{title}»',
  routes: 'Соберите черновик рейса из адресов разных Picking и найдите работы поблизости. Меняйте порядок остановок или длительность работ, чтобы пересчитать время прибытия и возврата.',
  calendar: 'Смотрите запланированные визиты и назначенные бригады по дням, неделям или месяцам. Выберите визит, чтобы открыть карточку доставки.',
  staffing: 'Выберите дату, чтобы увидеть участников каждого забронированного визита. Откройте редактор состава, чтобы проверить доступность людей и изменить назначения для этого визита.',
  imports: 'Запустите импорт из учебной базы Odoo в режиме чтения и проверьте результат. Откройте детали запуска, чтобы разобраться с предупреждениями или ошибками.',
  skills: 'Смотрите справочник навыков для требований к задачам и квалификаций участников. Администраторы могут добавлять, редактировать и отключать навыки.',
  vehicles: 'Проверяйте состояние машин компании и внешних перевозчиков. Чтобы забронировать машину, откройте забронированный визит в карточке доставки.',
  deliveryDetails: 'Проверьте адрес, инструкции и оставшиеся работы. На вкладках можно планировать визиты, разбирать проблемы и повторные выезды, смотреть доказательства и историю.',
  participantCalendar: 'Смотрите назначенные визиты и задачи участника по дням, неделям или месяцам. Выберите визит, чтобы открыть карточку доставки.',
  crews: 'Смотрите постоянные составы бригад. Нажмите на имя участника, чтобы открыть календарь, или перейдите в «Составы выездов», чтобы изменить участников конкретного визита.',
  participants: 'Ищите профили, контакты и навыки участников. Откройте календарь участника, чтобы увидеть запланированные визиты и назначенные задачи.',
  templates: 'Смотрите готовые шаблоны задач с чек-листами и требованиями к навыкам. Выберите шаблон при назначении работы бригаде на визит.',
  participantSkills: 'Смотрите, какими навыками владеет каждый участник. Администраторы могут обновлять навыки с учётом работ, которые участник может выполнить.',
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
  label: '{title} haqida',
  routes: 'Turli Picking manzillaridan marshrut qoralamasini tuzing va yaqin atrofdagi qolgan ishlarni toping. Bekatlar tartibini yoki ish davomiyligini o‘zgartirsangiz, yetib borish va qaytish vaqtlari qayta hisoblanadi.',
  calendar: 'Rejalashtirilgan tashriflar va tayinlangan brigadalarni kun, hafta yoki oy bo‘yicha ko‘ring. Yetkazmani ochish uchun tashrifni tanlang.',
  staffing: 'Band qilingan har bir tashrifga kim tayinlanganini ko‘rish uchun sanani tanlang. Xodimlarning bo‘sh vaqtini tekshirish va tayinlovni o‘zgartirish uchun tashrif tarkibini tahrirlang.',
  imports: 'Sinov Odoo bazasidan faqat o‘qish rejimida importni ishga tushiring va natijani tekshiring. Ogohlantirish yoki xatolarni ko‘rish uchun import tafsilotlarini oching.',
  skills: 'Vazifalarga qo‘yiladigan talablar va ishtirokchilar malakasini belgilash uchun ishlatiladigan ko‘nikmalarni ko‘ring. Administratorlar ko‘nikmalarni qo‘shishi, tahrirlashi yoki o‘chirib qo‘yishi mumkin.',
  vehicles: 'Kompaniya va tashqi transport vositalarining holatini tekshiring. Transportni band qilish uchun yetkazma tafsilotlarida band qilingan tashrifni oching.',
  deliveryDetails: 'Manzil, ko‘rsatmalar va qolgan ishlarni tekshiring. Bo‘limlarda tashriflarni rejalashtirish, muammolar va takroriy tashriflarni boshqarish, dalillar va tarixni ko‘rish mumkin.',
  participantCalendar: 'Ishtirokchiga tayinlangan tashrif va vazifalarni kun, hafta yoki oy bo‘yicha ko‘ring. Yetkazmani ochish uchun tashrifni tanlang.',
  crews: 'Brigadalarning doimiy tarkibini ko‘ring. Taqvimni ochish uchun ishtirokchi ismini bosing yoki ma’lum tashrif tarkibini o‘zgartirish uchun «Tashrif tarkibi»ga o‘ting.',
  participants: 'Ishtirokchilarning profili, aloqa ma’lumotlari va ko‘nikmalarini toping. Rejalashtirilgan tashriflar va tayinlangan vazifalarni ko‘rish uchun ishtirokchi taqvimini oching.',
  templates: 'Tekshiruv ro‘yxatlari va talab qilinadigan ko‘nikmalar kiritilgan vazifa andozalarini ko‘ring. Tashrif uchun brigadaga vazifa tayinlayotganda andoza tanlang.',
  participantSkills: 'Har bir ishtirokchining ko‘nikmalarini ko‘ring. Administratorlar ularni ishtirokchi bajara oladigan ishlarga moslab yangilashi mumkin.',
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
