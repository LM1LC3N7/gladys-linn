# Linn et OpenHome pour Gladys

Pilotez vos lecteurs réseau **Linn** (DS, DSM, Majik, Selekt, Klimax…) et les
autres appareils **OpenHome** depuis Gladys, en local, sans aucun cloud :
allumage, veille, volume, sourdine, source, épingles (les préréglages de
l'application Linn), lecture, pause, suivant, précédent et titre en cours.

> **Important.** Cette intégration n'a jamais été testée avec un vrai appareil :
> elle a été écrite d'après la bibliothèque `openhomedevice` (celle de Home
> Assistant) et testée avec un faux appareil seulement. Vos retours sont les
> bienvenus. Intégration non officielle, sans lien avec Linn Products.

## Ce n'est pas l'intégration DLNA

L'intégration [DLNA de guim31](https://github.com/guim31/gladys-dlna)
(`guim31/gladys-dlna`) pilote tout lecteur UPnP AV générique (services
`AVTransport` et `RenderingControl`) : lire une URL ou un serveur multimédia,
volume, lecture. Elle fonctionne aussi avec un Linn.

Celle-ci fait autre chose : elle ne parle qu'aux **services OpenHome**
(`urn:av-openhome-org`), que le DLNA n'a pas :

- les **sources** de l'appareil (Playlist, Radio, Songcast, entrées HDMI,
  analogiques, numériques…), à choisir dans une liste ;
- les **épingles** (« pins ») réglées dans l'application Linn : une radio, une
  liste de lecture, une entrée, rappelées d'un clic ;
- la **veille** (allumer, mettre en veille, état de marche) ;
- le volume **plafonné** et la sourdine du service Volume d'OpenHome.

Elle ne lit pas d'URL, ne parcourt pas de serveur multimédia et ne joue pas les
notifications : pour cela, gardez l'intégration DLNA. Les deux peuvent tourner
ensemble ; un même lecteur peut alors être créé dans chacune.

## Installation

1. Dans Gladys, installez l'intégration **Linn & OpenHome**.
2. Choisissez le **plafond de volume** (50 par défaut) dans sa configuration.
3. Ouvrez l'onglet **Découverte** : les lecteurs trouvés par la recherche SSDP
   (lancée par Gladys sur votre réseau) apparaissent. Créez-les.

Un lecteur sur un autre sous-réseau ou VLAN n'est pas trouvé par le SSDP :
saisissez alors l'URL de sa **description UPnP** dans la configuration
(champ facultatif, par exemple
`http://192.168.1.30:55178/<uuid>/Upnp/device.xml`). Un outil de découverte
UPnP sur votre ordinateur l'affiche.

## Ce que vous obtenez

| Fonction           | Type Gladys                    | Remarque                                                    |
| ------------------ | ------------------------------ | ----------------------------------------------------------- |
| Marche             | état binaire (lecture seule)   | 1 allumé, 0 en veille ou injoignable                        |
| Allumer            | bouton                         | sort le lecteur de la veille                                |
| Veille             | bouton                         | met le lecteur en veille                                    |
| Volume             | musique / volume (0 à 100)     | plafonné ; absent si le volume du lecteur est fixe          |
| Sourdine           | bouton (télévision / sourdine) | chaque appui lit l'état puis règle l'inverse                |
| Lecture, pause     | boutons musique                |                                                             |
| Suivant, précédent | boutons musique                | pas sur une radio                                           |
| Lecture en cours   | état musique (lecture seule)   | 1 en lecture, 0 sinon                                       |
| Source             | liste                          | les sources visibles, puis les épingles (« 3. FIP »)        |
| Titre              | texte (lecture seule)          | « Artiste - Titre » (ou le texte de la radio) ; « — » sinon |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume tout »
d'un assistant vocal ou d'une scène ne réveille ni ne coupe votre lecteur.

## Plafond de volume

Le volume demandé depuis Gladys (tableau de bord, scène, assistant vocal) ne
dépasse jamais le plafond de la configuration : un volume plus fort est ramené
au plafond. Le plafond est relu juste avant l'envoi : une nouvelle valeur
enregistrée s'applique tout de suite. Le volume réglé sur le lecteur lui-même
(bouton, télécommande, application) n'est pas modifié, sauf dans les cas où
Gladys le rendrait audible :

- **Retirer la sourdine** : si le volume dépasse le plafond, il est d'abord
  ramené au plafond, puis la sourdine est retirée.
- **Allumer**, ou choisir une source ou une épingle quand le lecteur est en
  veille : après le réveil, le volume est relu et ramené au plafond s'il le
  dépasse. Si le lecteur met du temps à se réveiller, l'intégration revérifie
  toutes les 2,5 s pendant 15 s environ.

## Lecture de l'état

Le conteneur de l'intégration n'a pas de port entrant : les événements UPnP
(GENA) ne peuvent pas lui parvenir. L'intégration lit donc chaque lecteur créé
à intervalle régulier (10 s par défaut, de 5 à 300 s) : veille, source,
volume, sourdine, état de lecture, et le titre seulement quand ses compteurs
disent qu'il a changé. Une requête à la fois par lecteur. En veille, seule la
veille est lue. La liste des sources et les épingles sont relues toutes les
30 minutes, ou quand une source inconnue est choisie.

Un lecteur qui ne répond plus est affiché éteint, cité dans le statut de
l'intégration, et réessayé à intervalles espacés (jusqu'à 5 minutes). Une
nouvelle recherche SSDP se lance alors d'elle-même toutes les 10 minutes au
plus, pour suivre une nouvelle adresse (le lecteur est reconnu par son UDN).

## Commandes

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend 5
secondes). Une commande qui n'a pas pu partir est signalée « not sent » (rien
envoyé) ; une commande partie sans réponse du lecteur est signalée « sent,
without confirmation » (envoyée, sans confirmation) ; un refus du lecteur
(erreur SOAP) est cité tel quel. Veille et sourdine passent avant les autres
commandes en attente. La source choisie est vérifiée sur la liste relue du
lecteur avant l'envoi ; une épingle doit exister sur le lecteur.

## Boutons de la configuration

- **Vérifier les lecteurs** : l'état de chaque lecteur créé (marche, source,
  volume, sourdine) et le plafond en vigueur.
- **Lister les sources et épingles** : relance la recherche, puis liste les
  sources visibles et les épingles de chaque lecteur.

## Sécurité, données et confidentialité

- L'intégration ne demande ni compte ni mot de passe : OpenHome n'en a pas.
  Elle n'écrit rien sur le disque. Rien ne sort de votre réseau local.
- Les réponses des lecteurs sont bornées (256 Ko pour une description, 64 Ko
  pour une réponse SOAP) et lues par un analyseur XML linéaire qui refuse
  tout `DOCTYPE` : aucune entité externe ni interne n'est jamais résolue.
- Une réponse SSDP n'est retenue que si son adresse de description est en
  `http` sur l'adresse privée qui a répondu ; chaque URL de commande doit
  rester sur la même machine et le même port que la description.

## Limites connues

- Pas de Songcast (groupes de pièces), de lecture d'URL, de notification, de
  balance, de minuterie ni de mise à jour du micrologiciel.
- Pas d'événements UPnP : un changement fait sur le lecteur apparaît au plus
  tard à la lecture suivante.
- Jamais testé avec un vrai appareil : les réponses réelles peuvent différer.
