# Apple Device Tracker

Cette intégration se connecte à votre compte iCloud, lit la position des
appareils visibles dans **Localiser** (Find My) et les expose dans Gladys comme
des **capteurs de présence**. Vous pouvez ensuite déclencher vos scènes sur
« mon iPhone arrive à la maison » ou « plus personne n'est là ».

## Ce que vous obtenez

Un appareil Gladys par appareil Apple (iPhone, iPad, Mac, Apple Watch,
AirPods, AirTag…), avec ces mesures :

| Mesure               | Type         | À quoi ça sert                                    |
| -------------------- | ------------ | ------------------------------------------------- |
| Présence             | Binaire      | Le déclencheur de vos scènes (1 = à la maison)    |
| Distance du domicile | Décimal (km) | Suivre l'éloignement, déclencher un pré-chauffage |
| Précision            | Entier (m)   | Savoir si la position vient du GPS ou du Wi-Fi    |
| Position             | Texte        | « latitude,longitude », pratique en debug         |
| Âge de la position   | Entier (min) | Détecter un appareil éteint qui ne remonte plus   |
| Batterie             | Entier (%)   | Alerter sur une batterie faible                   |
| En charge            | Binaire      | Savoir si l'appareil est branché                  |

Batterie et charge n'apparaissent que sur les appareils qui les remontent :
un AirTag n'en a pas.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Renseignez votre **identifiant Apple** (l'e-mail du compte iCloud) et votre
   **mot de passe**. Ils sont stockés chiffrés par Gladys et ne sont envoyés
   qu'à Apple.
3. La **latitude** et la **longitude** de votre domicile sont pré-remplies avec
   la position de votre maison Gladys : n'y touchez que si vous voulez un autre
   point de référence. Si elles restent vides — maison créée sans adresse —
   cliquez sur **Récupérer les coordonnées de ma maison Gladys** (l'action vous
   dit ce qui bloque), ou saisissez-les en degrés décimaux (`48.8566`,
   `2.3522`, à copier depuis n'importe quelle carte). Réglez le **rayon** dans lequel un appareil est
   considéré comme présent (150 m par défaut, à augmenter si votre terrain est
   grand ou si vos appareils sont souvent localisés par le Wi-Fi).
4. Enregistrez.

### Double authentification (2FA)

Si votre compte utilise la double authentification — c'est le cas par défaut
chez Apple — un code à 6 chiffres s'affiche sur vos appareils Apple juste après
l'enregistrement. L'intégration **demande explicitement** ce code à Apple :
un compte sans appareil de confiance (uniquement un numéro de téléphone) le
reçoit par **SMS**.

1. Notez le code. Le message affiché dans la Configuration précise où il a été
   envoyé (appareils de confiance, ou numéro de téléphone).
2. Dans l'onglet **Configuration**, cliquez sur **Envoyer le code de double
   authentification**, saisissez-le, validez.
3. L'intégration demande alors à Apple de **faire confiance** à cette session :
   le code n'est plus redemandé aux redémarrages suivants (Apple garde cette
   confiance environ 30 jours, parfois moins).

Si rien n'arrive, cliquez sur **M'envoyer un nouveau code de double
authentification** : Apple renvoie un code (push sur les appareils, puis SMS en
secours) sans repartir de zéro. Et si la notification n'arrive toujours pas sur
vos appareils, **M'envoyer le code par SMS** force l'envoi sur un numéro de
confiance.

## Réglages avancés

- **Intervalle de rafraîchissement** (`poll_frequency`, 300 s par défaut) :
  la fréquence à laquelle l'intégration demande une nouvelle position à Apple.
  C'est le réglage à ajuster en premier — plus court = présence plus réactive,
  mais plus d'appels chez Apple et plus de batterie consommée sur vos
  appareils. Le minimum accepté est 60 s. Gladys, de son côté, ne sait pas
  interroger plus lentement qu'une fois par minute : entre deux
  rafraîchissements réels, l'intégration répond simplement avec la dernière
  position connue. Quel que soit le réglage, elle n'interroge jamais Apple plus
  d'une fois toutes les 30 secondes, et un seul appel suffit pour tous vos
  appareils.
- **Précision maximale** (500 m par défaut) : une position annoncée avec un
  rayon d'incertitude supérieur est **ignorée**. Sans ce garde-fou, une
  position déduite du Wi-Fi de l'opérateur ferait « voyager » votre présence
  de plusieurs kilomètres.
- **Inclure les appareils de la famille** : expose aussi les appareils
  partagés via le partage familial.

### Anti-rebond de la présence

Un appareil devient présent dès qu'il entre dans le rayon, mais il ne devient
absent qu'à **125 % du rayon**. Avec un rayon de 150 m, il faut donc dépasser
187 m pour être déclaré parti. C'est ce qui évite qu'un téléphone posé en bord
de zone déclenche vos scènes en boucle à cause du bruit GPS.

## Actions disponibles

- **Envoyer le code de double authentification** — valide le code à 6 chiffres
  et fait approuver la session par Apple.
- **M'envoyer un nouveau code de double authentification** — redemande un code
  à Apple : push sur les appareils de confiance, ou SMS si le compte n'en a
  aucun.
- **M'envoyer le code par SMS** — force l'envoi sur un numéro de téléphone de
  confiance, même quand le compte a des appareils de confiance.
- **Récupérer les coordonnées de ma maison Gladys** — remplit la latitude et la
  longitude depuis votre maison Gladys, et affiche l'erreur exacte si Gladys ne
  les donne pas. Rechargez la page pour voir les champs remplis.
- **Tester la connexion iCloud** — relance une connexion et affiche le nombre
  d'appareils trouvés avec leurs noms.
- **Oublier la session enregistrée** — efface les jetons stockés. À utiliser si
  la connexion est bloquée dans un état bizarre : la connexion suivante repart
  de zéro (et redemandera un code 2FA).
- **Faire sonner un appareil** — choisissez un de vos appareils, il joue le son
  de Localiser. Pratique pour retrouver un téléphone dans le canapé.

## Dépannage

**« Connexion à iCloud impossible : ... »** : le message reprend la réponse
d'Apple. Les causes les plus fréquentes sont un mot de passe changé, un compte
temporairement verrouillé après trop d'essais, ou une session à réapprouver.

**Aucun appareil n'apparaît** : vérifiez que **Localiser mon iPhone** est
activé sur les appareils concernés (Réglages → votre nom → Localiser). Un
appareil éteint ou hors ligne depuis longtemps peut aussi ne remonter aucune
position ; il apparaîtra dans Gladys mais sans présence tant qu'Apple n'a rien
de récent.

**L'appareil que je viens d'ajouter reste vide** : ses mesures sont publiées
dès sa création, puis à chaque rafraîchissement. S'il reste vide, regardez
l'onglet Configuration (l'intégration doit être connectée à iCloud) et le champ
_Précision_ : un appareil dont Apple ne donne aucune position n'a ni présence,
ni distance.

**« Pas de valeur récente » sur le tableau de bord** : Gladys considère une
valeur comme périmée quand plus rien n'a été publié dessus depuis un moment
(48 heures par défaut). L'intégration republie chaque valeur au moins toutes les
30 minutes : ce message ne devrait donc apparaître que si l'intégration est
arrêtée, si elle n'arrive plus à se connecter à iCloud (regardez l'onglet
Configuration) ou si l'appareil ne remonte aucune position.

**La présence ne bouge pas** : regardez la mesure _Précision_. Si elle est
proche ou au-dessus de votre réglage « Précision maximale », les positions sont
ignorées — augmentez le seuil, ou le rayon du domicile.

**Je ne reçois aucun code 2FA** : utilisez **M'envoyer un nouveau code de
double authentification**, puis **M'envoyer le code par SMS**. Le message
affiché dans la Configuration reprend la raison donnée par Apple quand celui-ci
refuse d'envoyer quoi que ce soit. Vérifiez ensuite sur appleid.apple.com qu'un
appareil de confiance ou un numéro de téléphone de confiance est bien
enregistré : sans l'un des deux, Apple n'a nulle part où envoyer le code.

**Les coordonnées restent vides** : l'intégration lit la position de votre
maison via l'API de Gladys, ce qui demande l'autorisation `location` (déclarée
dans son manifeste) et une maison avec une adresse (Réglages → Maison).
L'action **Récupérer les coordonnées de ma maison Gladys** affiche la raison
exacte du refus.

**Le code 2FA est redemandé souvent** : c'est Apple qui décide de la durée de
confiance d'une session. Évitez de changer le mot de passe ou de révoquer les
sessions depuis appleid.apple.com.

L'intégration journalise tout ce qu'elle fait : consultez ses logs depuis
l'interface Gladys (ou `docker logs` sur l'hôte), avec `LOG_LEVEL=debug` pour
le détail complet.

## À savoir

Apple ne publie **aucune API officielle** pour Localiser. Cette intégration
utilise la même interface que le site web icloud.com, avec le même mécanisme de
connexion sécurisée (SRP : votre mot de passe ne quitte jamais votre machine,
seule une preuve cryptographique est envoyée). Apple peut modifier cette
interface sans prévenir : si l'intégration cesse de fonctionner du jour au
lendemain, c'est la cause la plus probable.

Vos identifiants restent chez vous, dans votre instance Gladys, et ne
transitent par aucun service tiers.
