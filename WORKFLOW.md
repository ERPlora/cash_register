# WORKFLOW — Caja

Prefijo: CASH_REGISTER
Alcance MVP: nucleo

> Contrato de comportamiento del módulo (pm#620, pm#621). Se lee antes de tocar el código y se
> actualiza en la misma PR que cambie un comportamiento. El detalle técnico vive en
> `architecture/modules/cash_register.md`; aquí se escribe lo que ve y hace la persona.

## Para qué sirve y para quién

Caja controla el efectivo del cajón por turnos: se abre una sesión con el fondo que hay en el cajón,
durante el turno se anotan solas las ventas y se apuntan a mano las entradas y salidas de efectivo,
se cuenta el cajón por billetes y monedas, y al cerrar se compara lo que debería haber (esperado)
con lo que se ha contado; la diferencia queda guardada. Sirve igual a la peluquería y al
restaurante. La usan el **empleado** que hace de cajero (abre, apunta, cuenta y cierra), el
**responsable** (lo mismo y además ve el efectivo esperado aunque el arqueo sea ciego) y el
**administrador** (además configura la caja y da de alta los cajones). El perfil «Cajero» que trae
Venta puede lo mismo que el empleado salvo ver el panel «Descuadres recientes». No cobra ni abre el
cajón físico: cobrar es de Venta y abrir el cajón, de Impresión.

## Referencia adoptada

Contrastada en `.claude/agents/qa-hub-restaurant.md` §2 (10/08/2026) y en las decisiones de
`architecture/modules/cash_register.md`; se adopta esto, no más:

- [Toast — revisión de turno](https://doc.toasttab.com/doc/platformguide/platformCompletingShiftReview.html):
  al cerrar se enseña lo que queda abierto y se avisa sin impedir el cierre; el cajón se cierra al
  corte del día de negocio (04:00 por defecto) si nadie lo cerró; el cierre ciego con un permiso que
  deja ver el esperado al supervisor.
- [Lightspeed — lista de comprobación del turno](https://resto-support.lightspeedhq.com/hc/en-us/article_attachments/360044738513):
  apertura con fondo, entradas y salidas, recuento ciego y cierre por turno.
- Square (gestión del cajón; sin enlace contrastado en esta pasada): «esperado en el cajón» visible
  durante el turno, entradas y salidas con motivo, informe del cajón por sesión con el desglose por
  forma de pago.
- Odoo (control de apertura del TPV; sin enlace contrastado en esta pasada): no se vende sin abrir la
  caja; la pantalla de apertura se pone delante del TPV.
- Del mercado en general: el cajón es solo efectivo (la tarjeta no cuenta para el esperado), un
  turno cerrado no se reabre, y lo que se corrige después se corrige con otro movimiento en el turno
  abierto, nunca reescribiendo el cerrado.

## Antes de empezar

- **Venta** instalada: es la que manda cada cobro, anulación y devolución a la caja. Sin Venta la
  caja solo lleva fondo, movimientos a mano y arqueos.
- **Ajustes guardados al menos una vez.** Mientras el administrador no pulse «Guardar» en la
  pestaña «Ajustes» de Caja, el negocio no tiene ajustes de caja: la pantalla enseña «Activar caja»
  encendido, pero **el TPV no se bloquea** y no se exige fondo ni recuento (CASH_REGISTER-F01,
  CASH_REGISTER-F04). La lista de primeros pasos del hub trae el paso opcional «Tu caja», que lleva
  a esos ajustes y se da por hecho al guardarlos.
- **Cajones**: opcionales. Delante del TPV, con uno solo no se pregunta (se elige solo) y con varios
  obliga a elegir; en Caja → «Abrir sesión» el campo «Cajón» sale vacío y, si no se elige, la
  sesión queda sin cajón. Hoy solo se dan de alta con el asistente (CASH_REGISTER-F02).
- **Moneda del hub**: el arqueo enseña los billetes y monedas de la moneda del hub (18 monedas); en
  cualquier otra pide el total a mano.

Configuración inicial, paso a paso:

1. Como administrador, abre **Caja → Ajustes**, decide fondo obligatorio, recuento obligatorio,
   saldo negativo, arqueo ciego y cierre automático, y pulsa «Guardar» (CASH_REGISTER-F01).
2. Si tienes varios cajones, pide al asistente que los dé de alta (CASH_REGISTER-F02).
3. Entra en el TPV: debe salir la pantalla «Abrir sesión de caja» en su lugar (CASH_REGISTER-F04).
   Abre la caja con el fondo real (CASH_REGISTER-F03) y comprueba que el TPV aparece.
4. Cobra una venta pequeña en efectivo y comprueba en **Caja → Detalle** que sube el esperado.

## Pantallas

### Caja
Menú **Caja**. Arriba, el título «Caja» y el botón «Abrir sesión» (apagado mientras haya una sesión
abierta en el negocio; al pasar por encima dice «Ya hay una sesión de caja abierta. Ciérrala antes
de abrir otra.»). Debajo, la tabla de sesiones, de la más reciente a la más antigua, 50 por página:
Sesión, Abierta el, Estado («Abierta», «Cerrada»), Apertura, Esperado, Contado, Diferencia. Buscador
«Buscar sesión…» (solo por número de sesión), filtro por número, filtro de estado por desplegable y
filtros de rango en los cuatro importes; vista tabla o tarjetas. Por fila, cuatro iconos: «Detalle», «Movimiento»,
«Arqueo» y «Cerrar»; tocar la fila abre también el detalle. «Movimiento», «Arqueo» y «Cerrar» sobre
una sesión cerrada no abren nada y avisan «La sesión S-… no está abierta». Cada acción despliega
su panel encima de la tabla:
- **Abrir sesión de caja**: «Cajón» (opcional), «Fondo de apertura», «Notas», «Abrir sesión» y
  «Cancelar».
- **Movimiento de caja · S-…**: «Tipo» («Entrada» o «Salida»), «Importe», «Concepto», «Registrar» y
  «Cancelar».
- **Arqueo de caja · S-…**: «Tipo de arqueo» («Cierre» por defecto, o «Apertura»), «Notas», una
  casilla por billete y por moneda bajo «Billetes» y «Monedas», y «Total contado» en vivo; sin tabla
  para la moneda del hub, un solo campo «Total contado». «Registrar arqueo» y «Cancelar».
- **Cerrar sesión · S-…**: la revisión del turno, «Esperado en el cajón» y «Diferencia» en vivo (si
  el arqueo no es ciego), «Efectivo contado», «Notas de cierre», «Cerrar sesión» y «Cancelar».
- **Detalle**: la pantalla Detalle de la sesión, con «Volver».

El éxito sale en verde debajo de los paneles («Sesión abierta», «Movimiento de entrada registrado
(…)», «Arqueo registrado · total contado …», «Sesión S-… cerrada · esperado … · contado … ·
diferencia …»); los errores, en un aviso rojo. Vacía: «Sin sesiones de caja.». Cargando:
«Cargando…». Error al cargar: el mensaje en la tabla con reintento.

### Detalle de la sesión
Desde **Caja**, «Detalle» o tocar una fila. Título «Detalle de la sesión · S-…». Un resumen en dos
columnas: Estado, Movimientos (cuántos), Fondo de apertura, Ventas (todas las formas de pago) y,
debajo, Ventas en efectivo, Ventas con tarjeta y Ventas con otras formas de pago (esta solo si hubo),
Devoluciones, Entradas, Salidas, Invitaciones, Esperado, Contado y Diferencia. En una sesión abierta
Contado y Diferencia salen «—». Debajo, dos tablas de la sesión, de lo más reciente a lo más antiguo,
50 por página y en tarjetas en el móvil: **Movimientos** (Cuándo, Tipo, Importe con su signo,
Método, Concepto) y **Arqueos** (Cuándo, Tipo de arqueo, Total contado, Notas). Vacías: «Sin
movimientos en esta sesión.» y «Sin arqueos en esta sesión.». Error: «No se pudo cargar el detalle
de la sesión» o el mensaje de cada tabla con reintento. No enseña quién abrió, cerró o hizo cada
movimiento, ni el cajón, ni las notas de apertura y cierre.

### Ajustes de Caja
Menú **Caja → Ajustes** (pestaña que pone el hub). Formulario con cabecera «Caja»: «Activar caja»,
«Exigir saldo de apertura», «Exigir saldo de cierre», «Permitir saldo negativo», «Arqueo ciego»,
«Cierre automático diario», «Hora del cierre automático» (de 00:00 a 23:00, en horas en punto) y
«URL del POS protegido» (de fábrica `/m/sales/pos/`), y el botón «Guardar». Sin ajustes guardados
enseña los valores de fábrica. Quien no es administrador lo ve de solo lectura con «Solo un
administrador puede cambiar estos ajustes.». Cargando: «Cargando ajustes…». Error: «No se pudieron
cargar los ajustes.» o, al guardar, «No se pudieron guardar los ajustes.». Guardado: «Ajustes
guardados.».

### Apertura de caja delante del TPV
No tiene menú: aparece en lugar del TPV de Venta cuando la caja está activada y no hay sesión
abierta. Una tarjeta con el icono de la caja, «Abrir sesión de caja», «Abre la caja para empezar a
vender.», «Cajón» (solo si hay más de uno), «Fondo de apertura», «Notas» y «Abrir sesión»
(«Abriendo…» mientras guarda). El error sale debajo del botón. Al abrirse la caja, el hub vuelve a
montar el TPV en la misma ruta.

### Paneles del inicio
En el **Inicio** del hub, dos paneles de la categoría «Caja»: «Caja (sesión actual)», con la cifra
«Efectivo esperado en caja» de la sesión abierta (solo administrador y responsable; vacío si no hay
sesión abierta), y «Descuadres recientes», con la diferencia de las ocho últimas sesiones cerradas
(administrador, responsable y empleado). Se refrescan solos al abrir o cerrar la caja y, el primero,
también con cada movimiento.

## Flujos

### CASH_REGISTER-F01 Configurar cómo funciona la caja
Estado: hecho
Vertical: comun
Actor: administrador
Pantalla: Ajustes de Caja
Pasos:
1. Abre Caja → Ajustes.
2. Enciende o apaga «Activar caja» (arma el bloqueo del TPV, CASH_REGISTER-F04), «Exigir saldo de apertura», «Exigir saldo de cierre», «Permitir saldo negativo», «Arqueo ciego» y «Cierre automático diario» con su hora; revisa «URL del POS protegido».
3. Pulsa «Guardar». Se guarda todo el formulario de una vez.
4. Sale «Ajustes guardados.»; desde ese momento el servidor aplica el fondo obligatorio (CASH_REGISTER-F03), el recuento obligatorio (CASH_REGISTER-F09), el saldo negativo (CASH_REGISTER-F05), el arqueo ciego (CASH_REGISTER-F07), el cierre automático (CASH_REGISTER-F10) y el bloqueo del TPV.
Entra: las decisiones del administrador.
Sale: los ajustes de caja del negocio, una sola fila por hub (avisa: cash_register.settings_updated). Antes del primer guardado no existe ninguna y no se aplica ninguna regla.
Si falla: «No se pudieron guardar los ajustes.» y los ajustes quedan como estaban. Quien no es administrador no ve «Guardar».
Implicados: pendiente
Pendiente de enlazar: hub — pintar la pestaña «Ajustes» de un módulo y su lista de primeros pasos
QA: ninguno

### CASH_REGISTER-F02 Dar de alta un cajón
Estado: parcial — no hay pantalla para crear, renombrar ni desactivar cajones; solo se crean con el asistente o la API
Vertical: comun
Actor: administrador, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente «crea un cajón llamado Barra» (uno por cajón físico).
2. El cajón aparece para elegir en «Cajón» al abrir la caja.
Entra: el nombre del cajón.
Sale: el cajón, activo.
Si falla: sin permiso de administrador el asistente no puede crearlo. No se comprueban nombres vacíos ni repetidos; sin nombre falla (texto sin confirmar).
Implicados: ninguno
QA: ninguno

### CASH_REGISTER-F03 Abrir el turno de caja con el fondo inicial
Estado: parcial — si dos dispositivos abren a la vez, el segundo ve «Sesión abierta» aunque no abrió nada (su fondo no se guarda)
Vertical: comun
Actor: empleado, responsable, administrador
Pantalla: Caja
Pasos:
1. En Caja, pulsa «Abrir sesión» (o, en el TPV, rellena la tarjeta de CASH_REGISTER-F04).
2. Elige el «Cajón» si hay varios (en Caja es opcional; delante del TPV es obligatorio con más de uno), escribe el «Fondo de apertura» tal como se lee («150,50»; vacío es 0) y, si quieres, «Notas».
3. Pulsa «Abrir sesión».
4. Sale «Sesión abierta»; la sesión aparece arriba de la tabla como «Abierta», con número `S-AAMMDD-NNNN` puesto por el sistema, y «Abrir sesión» se apaga. El TPV deja de estar bloqueado.
Entra: cajón, fondo y notas del cajero; los ajustes del negocio.
Sale: la sesión abierta, a nombre de quien la abre (avisa: cash_register.session_opened, con el fondo y las notas). El fondo cuenta para el esperado desde ese momento.
Si falla: «Ya hay una sesión de caja abierta. Ciérrala antes de abrir otra.» (solo hay una por negocio, sea cual sea el cajón); con el fondo obligatorio y fondo vacío o cero, en Caja «Este negocio exige fondo de apertura: indica el efectivo con el que empieza la caja.» y delante del TPV «Este negocio exige un fondo de apertura: indica el efectivo con el que empieza el cajón.»; un importe ilegible («Esto no es un importe. Escribe una cifra, por ejemplo 12,50.»), negativo o ambiguo («1.250») se para antes de enviar. Delante del TPV, con varios cajones y ninguno elegido, el aviso es solo la palabra «Cajón».
Implicados: REC_PELUQUERIA-F01, REC_RESTAURANTE-F01
QA: R-01, B-01, BD-04, qa-hub-restaurant §8 carreras (discrepa)

### CASH_REGISTER-F04 Vender solo con la caja abierta
Estado: parcial — el bloqueo no existe hasta que el administrador guarda los ajustes por primera vez, aunque la pantalla de ajustes enseñe «Activar caja» encendido; y quien se encuentra la caja cerrada fuera de la pantalla del TPV (anulando desde la lista de ventas, o con el TPV ya abierto cuando otro cierra la caja) solo ve el aviso genérico de Venta, que no menciona la caja
Vertical: comun
Actor: empleado, sistema
Pantalla: Apertura de caja delante del TPV
Pasos:
1. Con «Activar caja» guardado, la «URL del POS protegido» apuntando a Venta y ninguna sesión abierta, el cajero entra en el TPV.
2. En su lugar aparece la tarjeta «Abrir sesión de caja».
3. Abre la caja como en CASH_REGISTER-F03.
4. El TPV aparece solo, sin recargar.
Entra: los ajustes guardados («Activar caja» y «URL del POS protegido») y si hay sesión abierta.
Sale: nada propio. Mientras la caja esté cerrada, el hub rechaza cualquier orden de Venta, no solo cobrar, anular y devolver: también abrir una cuenta o una mesa, añadir o quitar líneas, enviar la comanda a cocina, dividir o juntar cuentas, descuentos, la vista previa del cobro, los ajustes de Venta, las formas de pago, los departamentos y las notas rápidas. Da igual que venga del TPV, del asistente, de un flujo o de la API. La pantalla solo tapa la ruta del TPV; las demás pantallas de Venta se abren, pero sus órdenes se rechazan. Solo aplica cuando la «URL del POS protegido» apunta a Venta.
Si falla: si la lectura de los ajustes o de la sesión falla, el TPV se deja abrir (el bloqueo cede antes que parar las ventas). Una orden de Venta rechazada porque la caja está cerrada solo da el aviso genérico de Venta, sin mención a la caja: al cobrar, «Error al cobrar»; al anular, «No se ha podido anular la venta»; al devolver, «No se ha podido registrar la devolución.». El asistente y la API reciben una frase en inglés del hub.
Implicados: SALES-F08, REC_PELUQUERIA-F01, REC_RESTAURANTE-F01
Pendiente de enlazar: hub — bloquear una ruta y las órdenes de un módulo mientras otro no cumpla su condición
QA: R-01, B-01, BD-04

### CASH_REGISTER-F05 Registrar una entrada o una salida de efectivo
Estado: hecho
Vertical: comun
Actor: empleado, responsable, administrador, asistente
Pantalla: Caja
Pasos:
1. En la fila de la sesión abierta, pulsa «Movimiento».
2. Elige «Entrada» (cambio traído de la caja fuerte) o «Salida» (pago a un proveedor, retirada al banco), escribe el «Importe» en positivo y el «Concepto».
3. Pulsa «Registrar».
4. Sale «Movimiento de entrada registrado (…)» o «Movimiento de salida registrado (…)»; en Detalle aparece el movimiento (la salida en negativo) y el esperado sube o baja.
Entra: tipo, importe y concepto. Desde la pantalla el medio es siempre efectivo; el asistente o la API pueden apuntar también tarjeta, transferencia u otro, que quedan en la lista y no cuentan para el esperado, aunque sí aparecen sumados en «Entradas» y «Salidas» del Detalle.
Sale: el movimiento, a nombre de quien lo apunta (avisa: cash_register.movement_added). El signo lo pone el sistema según el tipo, mande lo que mande quien llama.
Si falla: «Esta salida dejaría la caja en negativo y el saldo negativo no está permitido.» si los ajustes no lo permiten; «Importe inválido» con importe cero; un importe ilegible o negativo se para antes de enviar con su motivo; sesión cerrada en otro dispositivo: «Esa caja está cerrada: una caja cerrada no acepta movimientos nuevos.». Un movimiento equivocado no se edita ni se borra: se apunta el contrario con un concepto que diga por qué.
Implicados: ninguno
QA: BD-11, qa-hub-restaurant §14

### CASH_REGISTER-F06 Contar el cajón por billetes y monedas
Estado: parcial — el sistema no comprueba que la sesión del arqueo esté abierta ni sea del negocio (solo la pantalla lo impide)
Vertical: comun
Actor: empleado, responsable, administrador
Pantalla: Caja
Pasos:
1. En la fila de la sesión abierta, pulsa «Arqueo».
2. Deja «Cierre» (al final del turno) o elige «Apertura» (para comprobar el fondo); escribe cuántos hay de cada billete y moneda; «Total contado» se va sumando. Sin tabla para la moneda del hub, escribe el total.
3. Pulsa «Registrar arqueo».
4. Sale «Arqueo registrado · total contado …» y el arqueo aparece en Detalle. Si era de «Cierre», se abre directamente el panel de cierre con «Efectivo contado» ya puesto (CASH_REGISTER-F09); el arqueo no cierra nada por sí solo.
Entra: las cantidades por billete y moneda, o el total.
Sale: el arqueo con su desglose. Si se cuenta por billetes y monedas, el total lo suma el sistema con los decimales de la moneda del hub; si se escribe el total a mano (o lo manda la API), se guarda ese total y prevalece sobre cualquier desglose que venga con él.
Si falla: «No se pudo registrar el arqueo» u otro motivo en el aviso rojo; con el total a mano, el motivo sale bajo el campo y «Registrar arqueo» queda apagado.
Implicados: ninguno
QA: BD-11, R-10, B-07

### CASH_REGISTER-F07 Contar a ciegas: quién ve el efectivo esperado
Estado: parcial — el ciego oculta la cifra, no los datos: el empleado ve en Detalle cada movimiento con su importe y forma de pago, el fondo y los totales de entradas, salidas y devoluciones, y sumando llega al esperado (al asistente y a la API les pasa lo mismo); y tampoco el responsable ni el administrador ven el esperado en el panel de cierre ni en la columna Esperado de la tabla (solo en Detalle y en el panel del inicio)
Vertical: comun
Actor: administrador, responsable, empleado
Pantalla: Caja
Pasos:
1. El administrador enciende «Arqueo ciego» y guarda (CASH_REGISTER-F01).
2. Durante el turno, en la sesión abierta, la columna Esperado sale vacía para todos; en Detalle, el empleado ve «—» en Esperado y no ve el desglose de ventas por forma de pago, pero sí la lista de movimientos con sus importes; el responsable y el administrador sí lo ven en Detalle y en «Caja (sesión actual)».
3. El cajero cuenta (CASH_REGISTER-F06) y cierra (CASH_REGISTER-F09) sin ver el esperado.
4. Al cerrar aparecen esperado, contado y diferencia.
Entra: el ajuste «Arqueo ciego» y el permiso de ver el esperado (administrador y responsable).
Sale: nada nuevo; cambia lo que ve cada uno. La regla del saldo negativo sigue funcionando con el esperado real.
Si falla: sin ajustes guardados no hay arqueo ciego.
Implicados: ninguno
QA: BD-11, qa-hub-restaurant §14

### CASH_REGISTER-F08 Revisar lo que queda pendiente antes de cerrar
Estado: hecho
Vertical: comun
Actor: empleado, responsable, administrador
Pantalla: Caja
Pasos:
1. Al abrir el panel de cierre sale «Comprobando lo que queda pendiente…».
2. Si hay comandas en cocina sin servir o impresiones esperando, sale «Revisión del turno» con «Comandas sin servir: N» (y sus mesas o números) y «Impresiones pendientes: N (estaciones)». Sin nada pendiente no sale nada.
3. El primer «Cerrar sesión» no cierra: avisa «El turno se cerrará igualmente. Pulsa otra vez para confirmar.» y el botón pasa a «Cerrar de todos modos».
4. El segundo clic cierra (CASH_REGISTER-F09).
Entra: las comandas vivas de Cocina (solo si está instalada) y la cola de impresión del hub.
Sale: nada; avisa, nunca impide.
Si falla: si una de las dos lecturas no se puede hacer, sale «No se ha podido comprobar lo que queda pendiente, así que esta revisión puede estar incompleta.». Si la otra lectura no encontró nada pendiente, se cierra con un solo clic; si encontró comandas o impresiones, se pide igual la confirmación, con esa línea dentro del aviso.
Implicados: KITCHEN-F31, REC_PELUQUERIA-F16, REC_RESTAURANTE-F16
Pendiente de enlazar: hub — la cobertura de la cola de impresión por estación (`hub.print.coverage`), la misma que enseña Impresión en PRINTING-F01
QA: qa-hub-restaurant §14 (discrepa)

### CASH_REGISTER-F09 Cerrar el turno: esperado, contado y diferencia
Estado: parcial — un segundo cierre de la misma sesión (otro dispositivo, o el cierre automático justo antes) responde «cerrada» sin hacer nada y vuelve a anunciar el cierre
Vertical: comun
Actor: empleado, responsable, administrador
Pantalla: Caja
Pasos:
1. En la fila de la sesión abierta, pulsa «Cerrar» (o llega desde un arqueo de «Cierre», CASH_REGISTER-F06).
2. Escribe o revisa el «Efectivo contado» (viene puesto del último arqueo de cierre de esa sesión; nunca de uno de apertura); sin arqueo ciego, «Esperado en el cajón» y «Diferencia» se ven mientras escribes. Añade «Notas de cierre» si quieres.
3. Pulsa «Cerrar sesión» (dos veces si la revisión del turno avisó, CASH_REGISTER-F08).
4. Sale «Sesión S-… cerrada · esperado … · contado … · diferencia …»; la fila pasa a «Cerrada» con los tres importes fijos para siempre y «Abrir sesión» vuelve a encenderse.
Entra: el efectivo contado y las notas.
Sale: la sesión cerrada con esperado (fondo + ventas, entradas y salidas en efectivo con su signo − devoluciones y anulaciones en efectivo; lo cobrado o apuntado con tarjeta, transferencia u otro no cuenta), contado y diferencia (contado − esperado: positiva sobra, negativa falta) (avisa: cash_register.session_closed). Lo que llegue después (una anulación de ayer) va al turno abierto, nunca a este.
Si falla: «Escribe el efectivo contado para cerrar la sesión.» con el campo vacío (la pantalla siempre lo pide, esté o no el ajuste; el ajuste de recuento obligatorio lo hace cumplir también al asistente y a la API, que reciben el rechazo `cash_register.closing_balance_required`); importe ilegible, negativo o ambiguo, con su motivo. No hay forma de reabrir una sesión cerrada por error: se abre otra con el efectivo real como fondo.
Implicados: FLOWS-F04, PRINTING-F17, REC_PELUQUERIA-F16, REC_RESTAURANTE-F16
QA: R-10, B-07, BD-11, qa-hub-restaurant §14 (discrepa), qa-hub-restaurant §8 carreras (discrepa)

### CASH_REGISTER-F10 Cerrar solo la caja olvidada al final del día
Estado: hecho
Vertical: comun
Actor: sistema
Pantalla: ninguna
Pasos:
1. El administrador enciende «Cierre automático diario» y elige la hora (04:00 de fábrica) en Ajustes.
2. Cada 5 minutos el hub mira si ya ha pasado el último corte en la hora local del negocio y cierra la sesión que siga abierta desde antes de ese corte; la abierta después del corte no se toca. Un hub apagado durante el corte la cierra en cuanto vuelve.
3. En Caja, la sesión aparece «Cerrada» con su esperado y Contado y Diferencia vacíos.
Entra: el ajuste, la hora y la zona horaria del negocio: la zona del hub; si no hay, la de su región (Canarias, Azores, Madeira) o la de su país; un hub sin país usa la hora de Madrid, y UTC solo se usa con un país que no está en la tabla del módulo.
Sale: la sesión cerrada sin recuento, sin persona que la cerrara y con una marca en las notas de cierre (que ninguna pantalla enseña) (avisa: cash_register.session_closed, también en las pasadas que no cierran nada).
Si falla: sin ajustes guardados o con el ajuste apagado no cierra nada. No hay aviso a nadie de que la caja se cerró sola.
Implicados: ninguno
QA: ninguno

### CASH_REGISTER-F11 Consultar una sesión y revisar un descuadre
Estado: parcial — el detalle no enseña quién abrió, cerró o hizo cada movimiento, ni el cajón, ni las notas de apertura y cierre; no se imprime
Vertical: comun
Actor: responsable, administrador, empleado
Pantalla: Detalle de la sesión
Pasos:
1. En Caja, pulsa «Detalle» o toca la fila de cualquier sesión, abierta o cerrada.
2. Lee el resumen: fondo, ventas por forma de pago, devoluciones, entradas, salidas, invitaciones aparte (son coste, no efectivo), esperado, contado y diferencia.
3. Repasa Movimientos: cada venta y devolución se nombra por su documento («Factura …», «Tique …», «Venta …», «Devolución de …», «Anulación de …»); un movimiento a mano enseña el concepto escrito. Y repasa Arqueos.
4. Pulsa «Volver».
Entra: la sesión elegida; el número de factura o tique de cada venta, si Facturación o Venta lo dan.
Sale: nada; es de solo lectura.
Si falla: «No se pudo cargar el detalle de la sesión» o el error de cada tabla con reintento. Sin Facturación, o sin permiso para leer facturas, el concepto es «Venta …» con el número de venta, o «Venta» a secas.
Implicados: INVOICE-F20, SALES-F01
QA: R-10, B-07

### CASH_REGISTER-F12 Ver la caja en los paneles del inicio
Estado: hecho
Vertical: comun
Actor: responsable, administrador, empleado
Pantalla: Paneles del inicio
Pasos:
1. En el Inicio del hub, añade (o encuentra ya puestos) «Caja (sesión actual)» y «Descuadres recientes».
2. «Caja (sesión actual)» enseña el efectivo esperado de la sesión abierta y se mueve con cada venta y movimiento; «Descuadres recientes», la diferencia de las ocho últimas sesiones cerradas.
Entra: la sesión abierta y las sesiones cerradas.
Sale: nada.
Si falla: sin sesión abierta el primer panel sale vacío; el empleado no ve el primero (solo administrador y responsable).
Implicados: pendiente
Pendiente de enlazar: hub — pintar los paneles de los módulos en el inicio
QA: R-01

### CASH_REGISTER-F13 Anotar en la caja cada cobro de una venta
Estado: parcial — si la venta llega sin ninguna caja abierta (bloqueo del TPV sin armar, o la caja se cerró entre el cobro y la anotación) no se anota y nadie se entera
Vertical: comun
Actor: sistema
Pantalla: ninguna
Pasos:
1. El cajero cobra en el TPV de Venta.
2. Sin que nadie teclee nada, la sesión abierta del negocio (sea de quien sea) recibe un movimiento «Venta» por cada forma de pago del cobro: con pago mixto, uno en efectivo y otro en tarjeta.
3. Cada movimiento lleva lo que esa forma de pago cubrió, no lo entregado: el cambio ya salió del cajón.
4. Solo los de efectivo suben el esperado; los de tarjeta, transferencia u otro quedan en la lista y en «Ventas con tarjeta» o «Ventas con otras formas de pago». El coste de las invitaciones va aparte, una vez por venta, a «Invitaciones».
Entra: el cobro de Venta: total, formas de pago con su tipo, importe de cada una y coste de las invitaciones (sale.completed).
Sale: los movimientos de venta (avisa: cash_register.movement_added). Una venta de total cero sin invitaciones no deja nada; una toda invitación deja un movimiento de importe cero con su coste.
Si falla: sin caja abierta la venta se cobra y la caja no la anota (no hay rechazo ni aviso); con el bloqueo del TPV armado ese caso solo puede darse si la caja se cierra mientras llega el cobro.
Implicados: SALES-F01, SALES-F02, SALES-F03, SALES-F08, SALES-F15, REC_PELUQUERIA-F09, REC_RESTAURANTE-F11
QA: R-09, B-06, BD-11, qa-hub-restaurant §10

### CASH_REGISTER-F14 Compensar en la caja una venta anulada
Estado: parcial — si la caja se cierra justo entre la comprobación de que hay caja abierta y la anotación (otro dispositivo o el cierre automático), no se anota nada, el aviso se da por entregado y no queda rastro
Vertical: comun
Actor: sistema
Pantalla: ninguna
Pasos:
1. Alguien anula en Venta una venta ya cobrada.
2. Si esa venta dejó efectivo vivo en el cajón (lo cobrado en efectivo menos lo ya devuelto en efectivo), la sesión abierta ahora recibe una «Devolución» por ese importe, que en Detalle se lee «Anulación de …» y baja el esperado. El movimiento original no se toca.
3. Va siempre al turno abierto, aunque la venta sea de un turno ya cerrado.
4. Si se pagó solo con tarjeta, o ya se devolvió entera en efectivo, no se anota nada.
Entra: la venta anulada (sale.voided) y los movimientos de esa venta en la caja.
Sale: el movimiento de compensación (avisa: cash_register.movement_added). Una segunda entrega del mismo aviso no duplica nada.
Si falla: con efectivo que devolver y ninguna caja abierta, la caja rechaza la anotación: el hub la reintenta durante unos minutos y, si sigue sin caja, queda en la lista de avisos fallidos del hub, de donde un administrador la reintenta. La venta queda anulada igualmente. Con el bloqueo del TPV armado (CASH_REGISTER-F04) este caso solo se da si la caja se cierra después de anular: con la caja ya cerrada, Venta no llega a anular (SALES-F08). Anular no corrige nada fiscal: el tique sigue emitido y declarado (SALES-F30). Si la caja se cierra justo mientras se anota, no se anota nada y no hay rechazo ni reintento.
Implicados: SALES-F30, REC_PELUQUERIA-F14, REC_RESTAURANTE-F15
Pendiente de enlazar: hub — reintentar y listar los avisos que un módulo no pudo procesar
QA: R-11, B-08, qa-hub-restaurant §13

### CASH_REGISTER-F15 Anotar en la caja una devolución
Estado: parcial — si la caja se cierra justo entre la comprobación de que hay caja abierta y la anotación (otro dispositivo o el cierre automático), no se anota nada, el aviso se da por entregado y no queda rastro
Vertical: comun
Actor: sistema
Pantalla: ninguna
Pasos:
1. Alguien hace en Venta una devolución, total o parcial, de una venta de hoy o de otro día.
2. La sesión abierta ahora recibe una «Devolución» por cada forma de pago por la que vuelve el dinero; en Detalle se lee «Devolución de …».
3. Manda por dónde vuelve el dinero, no cómo se cobró: una venta con tarjeta devuelta en efectivo baja el esperado; una en efectivo devuelta a la tarjeta no lo toca.
Entra: el documento de devolución con sus formas de pago, importes y su referencia (sale.refunded).
Sale: los movimientos de devolución (avisa: cash_register.movement_added). Cada documento se anota una sola vez por cada cobro de origen del que sale el dinero, aunque el aviso llegue dos veces.
Si falla: con una parte en efectivo y ninguna caja abierta, la caja la rechaza (reintentos y después avisos fallidos, como en CASH_REGISTER-F14); solo con tarjeta y sin caja abierta, no se anota nada y no es un error. Con el bloqueo del TPV armado, con la caja ya cerrada Venta no llega a devolver (SALES-F08). Una devolución sin referencia de documento se rechaza. Si la caja se cierra justo mientras se anota, no se anota nada y no hay rechazo ni reintento.
Implicados: SALES-F31, REC_PELUQUERIA-F14, REC_RESTAURANTE-F15
QA: R-11, B-08, qa-hub-restaurant §13

## Qué comparten los verticales

Todo el módulo es común: peluquería y restaurante usan los mismos flujos, la misma pantalla y las
mismas reglas. Tocar una pieza de esta tabla afecta a los dos negocios.

| Pieza compartida | Flujos que la usan |
|---|---|
| Una sola sesión abierta por negocio, sea cual sea el cajón | F03, F04, F05, F06, F09, F13, F14, F15 |
| La fórmula del esperado (fondo + efectivo firmado por su tipo), igual en la tabla, el detalle, el panel del inicio, el cierre a mano y el automático | F05, F07, F09, F10, F11, F12, F13, F14, F15 |
| La fila de ajustes del negocio: un solo guardado arma el bloqueo del TPV, el fondo y el recuento obligatorios, el saldo negativo, el arqueo ciego y el cierre automático | F01, F03, F04, F05, F07, F09, F10 |
| La puerta de los cobros de Venta: el mismo aviso de venta cobrada sirve al tique de la peluquería y a la cuenta de la mesa | F13 |
| La revisión del turno: las comandas solo existen con Cocina (restaurante); las impresiones pendientes, en los dos | F08, F09 |
| El bloqueo de la ruta del TPV de Venta (`/m/sales/pos/` de fábrica) | F04 |

## Cobertura contra la referencia

| Elemento de la referencia | Estado | Flujo |
|---|---|---|
| Abrir turno con fondo, fondo obligatorio opcional | hecho | F01, F03 |
| No vender sin caja abierta | parcial: solo tras guardar los ajustes, y el rechazo fuera del TPV no dice que la caja está cerrada | F04 |
| Elegir cajón al abrir | hecho | F03 |
| Varios cajones abiertos a la vez | no hecho (una sesión por negocio, decidido en cash_register#11) | — |
| Alta y baja de cajones en pantalla | no hecho (solo asistente) | F02 |
| Entradas y salidas de efectivo con motivo | hecho | F05 |
| Bloquear el saldo negativo | hecho | F05 |
| Abrir el cajón sin venta, con permiso y registro | no hecho (es de Impresión) | — |
| Ventas en efectivo anotadas solas; tarjeta fuera del cajón | hecho | F13 |
| Pago mixto: una línea por forma de pago | hecho | F13 |
| Venta sin caja abierta | parcial: se pierde en silencio | F13 |
| Anulación y devolución compensan en el turno abierto | parcial: se pierden si la caja se cierra justo mientras se anotan | F14, F15 |
| Esperado en el cajón visible durante el turno | hecho | F09, F11, F12 |
| Arqueo por billetes y monedas de la moneda del negocio | hecho | F06 |
| Arqueo ciego con permiso de supervisor | parcial: el cajero ve los movimientos y puede sumarlos; el supervisor no ve el esperado al cerrar | F07 |
| Revisión del turno al cerrar (avisa, no impide) | hecho: comandas e impresiones; no cuentas ni mesas abiertas | F08 |
| Cerrar con esperado, contado y diferencia | hecho | F09 |
| Aprobar una diferencia fuera de umbral, nota obligatoria | no hecho | — |
| Cierre automático al corte del día de negocio | hecho | F10 |
| Informe del cajón por sesión con desglose por forma de pago | hecho en pantalla | F11 |
| Quién abrió, cerró y movió cada importe, a la vista | no hecho (se guarda, no se enseña) | F11 |
| Informe X y Z impresos | no hecho | — |
| Indicadores de caja en el inicio | hecho | F12 |
| Turno cerrado no se reabre ni se edita | hecho | F09 |
| Propinas en caja | no hecho | — |

## Datos: de quién es cada dato

- **Propios**: ajustes de caja (uno por negocio), cajones, sesiones (fondo, esperado, contado,
  diferencia, número de turno y el contador diario que lo numera), movimientos y arqueos con su
  desglose. Fuera de Caja solo se leen por sus consultas públicas: el hub lee los ajustes y la
  sesión abierta para bloquear el TPV.
- **De Venta**: llegan por sus avisos de venta cobrada, anulada y devuelta; la caja guarda la
  referencia de la venta, el nombre de la forma de pago tal como la llama Venta («Efectivo»,
  «Tarjeta»), su tipo y, en las devoluciones, la referencia del documento y del cobro de origen. No
  lee las tablas de Venta.
- **De Facturación y Venta, solo para pintar**: el número de factura, tique o venta de cada
  movimiento, por consultas opcionales; si no están instalados, no pasa nada.
- **De Cocina y del hub, solo al cerrar**: las comandas vivas y la cola de impresión.
- **Del hub**: la moneda y sus decimales, la zona horaria y el país del negocio.
- **Datos personales** (inventario RGPD, de las migraciones):
  - sesión: quién la abrió, notas de apertura y de cierre (texto libre);
  - movimiento: quién lo hizo y su concepto (texto libre: puede nombrar a un proveedor o a una
    persona); la referencia de la venta lleva hasta el cliente que guarda Venta;
  - arqueo: notas (texto libre);
  - cajón: su nombre;
  - en todas las tablas: qué empleado creó y cambió cada fila;
  - los ajustes antiguos de abrir al iniciar sesión y cerrar al salir siguen como columnas retiradas
    (sin datos personales);
  - copias fuera de Caja: los avisos de turno abierto, turno cerrado y movimiento llevan lo que se
    escribió al hacerlo (fondo, notas, concepto) y el usuario que lo hizo; el aviso de movimiento
    que nace de un cobro, de una anulación o de una devolución reenvía además el aviso entero de
    Venta: nombre, NIF, dirección y país del cliente, quién atendió, las líneas de la venta, y el
    motivo y quién anuló o devolvió. Todos los avisos llevan también la razón social, el NIF y la
    dirección del negocio.

## Reglas que no se rompen

- **Aislamiento**: toda lectura va con el negocio; un movimiento no se puede colgar de una sesión de
  otro negocio (el arqueo no lo comprueba: hueco de CASH_REGISTER-F06).
- **Una sola sesión abierta por negocio**: la base de datos no admite dos, nunca quedan dos
  abiertas. Abrir con una ya abierta se rechaza; si dos aperturas llegan a la vez, la segunda
  responde bien sin abrir nada (hueco de CASH_REGISTER-F03).
- **El signo lo pone el sistema**: entrada y venta suman, salida y devolución restan, según el
  tipo y no según el signo con que llegue el importe; las lecturas lo derivan también para las filas
  antiguas.
- **El esperado es solo efectivo**: se suma por el tipo de la forma de pago, nunca por su nombre
  traducido.
- **Un turno cerrado no se mueve**: guarda su esperado, contado y diferencia; las lecturas
  enseñan esas cifras y no las recalculan, y ninguna anulación ni devolución posterior cae en él.
- **Un movimiento a mano solo entra en una sesión abierta del negocio**, comprobado por el sistema.
- **Lo que no existe**: no hay orden para reabrir una sesión, ni para editar o borrar un movimiento o
  un arqueo.
- **Los ajustes, una vez guardados, los aplica el servidor**: fondo obligatorio, recuento
  obligatorio y saldo negativo se cumplen también por el asistente y la API. El arqueo ciego oculta
  la cifra del esperado en todas las lecturas, pero no la lista de movimientos (hueco de
  CASH_REGISTER-F07).
- **El número de turno lo pone el sistema** (`S-AAMMDD-NNNN`, correlativo por día), venga la apertura
  de donde venga; un número enviado por quien llama se ignora.
- **Una anulación o devolución con efectivo y sin caja abierta se rechaza**: el aviso se reintenta y
  después queda en la lista de avisos fallidos (si la caja se cierra justo mientras se anota, se
  pierde: hueco de CASH_REGISTER-F14 y CASH_REGISTER-F15). Cada devolución se anota una vez por
  documento y por cada cobro de origen del que sale el dinero; cada anulación, una vez.
- **El TPV bloqueado lo aplica el servidor**: con la caja activada y cerrada y la «URL del POS
  protegido» apuntando a Venta, el hub rechaza cualquier orden de Venta (abrir cuenta, añadir
  líneas, enviar a cocina, cobrar, anular, devolver, ajustes…), venga de donde venga.
- **Permisos**: abrir, apuntar, contar y cerrar, cualquier perfil con caja; ver el esperado con el
  arqueo ciego, administrador y responsable; ajustes y cajones, solo administrador. El servidor lo
  aplica aunque la pantalla enseñe el botón.
- **Dinero**: importes enteros en la unidad más pequeña de la moneda del hub. Un arqueo por billetes
  y monedas lo suma el sistema con los decimales de esa moneda, nunca con los que mande la
  pantalla; un total escrito a mano (o enviado por la API) se guarda tal cual y prevalece sobre el
  desglose.

## Lo que NO hace, a propósito

- No cobra ni factura: eso es de Venta, Facturación y VeriFactu.
- No abre el cajón físico: lo abre el hub en el dispositivo que cobró si el ajuste de Impresión lo
  pide, con cualquier forma de pago.
- No lleva varios cajones abiertos a la vez: una sesión por negocio (cash_register#11).
- No reabre turnos ni edita o borra movimientos: se corrige con otro movimiento.
- No abre la caja al iniciar sesión ni la cierra al salir: esos ajustes se retiraron
  (cash_register#23) porque nadie los leía y ningún TPV de referencia lo hace.
- No gestiona propinas, banco ni caja fuerte más allá de una salida de efectivo.
- No imprime informes de caja.
- El estado «Suspendida» existe en la tabla, pero nada lleva a una sesión a ese estado.

## Dudas abiertas

Se resuelven con `market-decision`; no las decide el worker.

1. ¿Una sesión por negocio (hoy) o una por cajón o por cajero, como espera `qa-hub-restaurant` §14?
2. ¿Aprobación del responsable y nota obligatoria cuando la diferencia pasa de un umbral?
3. ¿Informe Z impreso al cerrar? Impresión ya conoce el tipo de documento de informe de sesión, pero
   nadie lo manda.
4. Venta cobrada sin caja abierta (F13): ¿rechazarla, anotarla en la siguiente sesión o avisar?
5. ¿El bloqueo del TPV debe venir armado al instalar Caja, sin esperar a que se guarden los ajustes?
6. ¿La revisión del turno debe mirar también cuentas y mesas abiertas y cobros pendientes
   (`qa-hub-restaurant` §14), y llegar a impedir el cierre?
7. Arqueo ciego: ¿el responsable debe ver el esperado en el panel de cierre?
8. El número de turno toma la fecha en UTC: ¿debe ser la del día de negocio?
9. ¿Abrir el cajón sin venta («no-sale») con permiso y registro, y de quién es: Caja o Impresión?
10. Los paneles del inicio se sugieren a los negocios de comercio y hostelería: ¿también a la
    peluquería?

## Fuentes contrastadas

Contra `origin/main` v1.3.74 (05/10/2026). Una línea por discrepancia; manda el código.

- **`docs/screens.md`**: el número de turno sale como `S-YYMMDD-HHMMSS`; es `S-AAMMDD-NNNN`, correlativo por día, desde cash_register#49 (F03).
- **`docs/screens.md`**: la lista de movimientos «searchable… filterable»; en Detalle no tiene buscador ni filtros, y la tabla de sesiones no tiene columna ni filtro de cajón (F11).
- **`docs/overview.md`, `docs/concepts.md` y el manual**: «esperado = fondo + todos los movimientos»; solo cuentan los de efectivo (F09).
- **`docs/overview.md`** y la sección «Eventos» de `architecture/modules/cash_register.md`: solo escucha venta cobrada y anulada; escucha también la devolución desde cash_register#62 (F15). El documento técnico dice además que un cobro deja «1 operación»; deja una por forma de pago (F13).
- **`docs/concepts.md`, `docs/limits.md`, el comentario de `record_refund`/`record_sale` en el handler y `architecture/`**: el movimiento cae «en la sesión abierta de quien lo apunta» o «del usuario activo»; cae en la sesión abierta del negocio, sea de quien sea (F13).
- **`docs/overview.md`, `docs/concepts.md` y el texto de error `cash_register.void_no_open_session`/`refund_no_open_session`** («Abre la caja y se reintentará»): el hub reintenta 8 veces en unos minutos; después queda en avisos fallidos y hay que reintentarlo a mano (F14, F15). El texto `ui.errRefundNoOpenSession` dice otra cosa («regístralo como salida de efectivo») y ninguna pantalla lo usa.
- **`docs/limits.md`** («Someone can sell without opening the till: turn on Activar caja») y el manual: lo que arma el bloqueo es guardar los ajustes una vez; el interruptor ya sale encendido antes (F04).
- **Descripción del ajuste «Activar caja»** («Habilita la gestión de caja (apertura/cierre de sesión)»): solo arma el bloqueo del TPV; abrir y cerrar funcionan igual con él apagado (F01).
- **`architecture/modules/cash_register.md`**: las columnas de abrir al iniciar sesión y cerrar al salir «se eliminaron en 006»; siguen en la tabla, retiradas sin borrar (Datos).
- **Manual (`hand-book/modulos/cash_register.md`)**: «Cree los cajones necesarios»; no hay pantalla para ello (F02). «Suspendida: no está operativa hasta que se resuelva»; nada lleva a ese estado.
- **Comentarios de `commands/open_session.sql` y `commands/add_movement.sql`** y del mapa de errores del panel: citan una comprobación de filas (`expect_rows`) que `module.json` no declara; por eso la doble apertura y el doble cierre responden bien sin hacer nada (F03, F09).
- **`qa-hub-restaurant` §14**: «una sola sesión por caja/usuario»; es por negocio (F03, duda 1). «Diferencia fuera de umbral con aprobación y nota»; no existe (duda 2). «No cerrar turno con comandas o cobros pendientes»; avisa sin impedir y no mira cuentas abiertas (F08). «Informe X y Z numerado»; no hay papel (duda 3). «Arqueo ciego para cajero y esperado visible para encargado»; el encargado tampoco lo ve al cerrar (F07).
- **`qa-hub-restaurant` §8, casos de carrera** («dos aperturas/cierres: nunca dos éxitos»): la segunda apertura simultánea y el segundo cierre responden bien sin hacer nada (F03, F09).
- **Rechazo de una orden de Venta con la caja cerrada** (`protects_guard`): ni el shell ni el SDK lo traducen y Venta no lo reconoce, así que el cajero ve el aviso genérico de Venta («Error al cobrar», «No se ha podido anular la venta», «No se ha podido registrar la devolución.»), sin mención a la caja; el asistente y la API reciben la frase en inglés del hub (F04).
- **Descripción del ajuste «Arqueo ciego»** («Quien cuenta la caja no ve el efectivo esperado hasta declarar el recuento»): no ve la cifra, pero sí cada movimiento en Detalle, y puede sumarla (F07).
- **Comentario de `_refund_movement_for_open_session.sql` y del handler** («rechaza en voz alta… para que el evento caiga al dead-letter en vez de evaporarse»): la comprobación de caja abierta se hace antes de la escritura, sin comprobación de filas, así que un cierre en medio la evapora igual (F14, F15).
- **Apertura delante del TPV con varios cajones y ninguno elegido**: el aviso es la etiqueta «Cajón» a secas, no una frase; y el panel de Caja deja abrir sin cajón en el mismo caso (F03).
- **Cierre automático**: la marca en las notas está en inglés («auto-closed by schedule (cash_register#23)»); existe la cadena `ui.autoClosedNote` en español que no usa nadie, y ninguna pantalla enseña las notas (F10, F11).
