# Russian Trusted Root CA

`russian_trusted_root_ca.pem` — корневой сертификат НУЦ Минцифры России. Им подписаны HTTPS-сертификаты GigaChat API, а в стандартный набор Node.js он не входит. Сервис добавляет его к стандартным корневым сертификатам только для запросов к GigaChat.

- Источник: https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer (Госуслуги)
- Subject: C=RU, O=The Ministry of Digital Development and Communications, CN=Russian Trusted Root CA
- Действует до: 27.02.2032
- SHA-256: D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
