# Lanette : lanceur d'applications pour Windows 10/11

Lanette rassemble vos programmes (.exe), raccourcis (.lnk, .url Steam/Epic), dossiers, fichiers et liens web dans une seule fenêtre. Elle s'ouvre avec **Alt+Espace** depuis n'importe où, trouve ce que vous tapez instantanément, et lance l'élément avec **Entrée**.

100 % local : aucune télémétrie. Lanette ne se connecte à Internet que si vous cliquez sur « Vérifier les mises à jour ».

---

## 1. Plan d'architecture

1. **Tauri 2** : un exécutable Rust natif, avec une interface HTML/CSS/JS vanilla affichée par WebView2 (déjà présent sur Windows 10/11). Pas de framework, pas de bundler.
2. **Rust = tout ce qui touche au système** : lancement via `ShellExecuteExW` (UAC, arguments, dossier de travail), lecture des .lnk (COM `IShellLinkW`), scan du menu Démarrer et du Store (`shell:AppsFolder`).
3. **Icônes** : extraites par le Shell Windows (`IShellItemImageFactory`), converties en PNG, mises en cache sur disque, servies par un protocole `icon://` traité par 3 threads en arrière-plan. Côté interface : `loading="lazy"`.
4. **Fenêtre persistante** : jamais détruite, seulement masquée. Elle réapparaît donc instantanément, sur l'écran où se trouve la souris. Quand elle est cachée, WebView2 passe en mode « mémoire basse ».
5. **Configuration** : un JSON lisible dans `%APPDATA%\Lanette\config.json` (écriture atomique, plus une copie `.bak`). Mode portable si un fichier `portable` est posé à côté de l'exe.
6. **Plugins Tauri officiels** : instance unique, raccourci global, lancement avec Windows, boîtes de dialogue. Zone de notification native.
7. **Frontend** : modules ES (état, rendu, recherche floue, glisser-déposer en Pointer Events, fenêtres, i18n). Animations uniquement via `transform` et `opacity`.

**Pourquoi Tauri plutôt que .NET/WPF ou C++ ?** WPF demande le runtime .NET (ou un exe autonome de plus de 60 Mo) et rend le design Windows 11 laborieux. Le C++ natif serait le plus léger, mais coûterait beaucoup plus cher à écrire pour une interface aussi soignée. Tauri donne un exe d'environ 3 à 5 Mo, avec une interface moderne facile à faire évoluer.

---

## 2. Arborescence

```
lanette/
├── package.json                  ← contient seulement le CLI Tauri
├── README.md
├── app-icon.png                  ← source 1024 px pour régénérer les icônes
├── .gitignore
├── .github/workflows/
│   └── build-windows.yml         ← compilation automatique sur GitHub
├── src/                          ← interface (HTML/CSS/JS vanilla)
│   ├── index.html
│   ├── styles.css
│   ├── locales/
│   │   └── fr.js                 ← tous les textes (ajouter en.js, etc.)
│   └── js/
│       ├── main.js               ← démarrage, clavier, lancement, menus
│       ├── render.js             ← onglets, grille/liste, sélection
│       ├── dialogs.js            ← ajout, import, modification, paramètres
│       ├── store.js              ← état + sauvegarde
│       ├── dnd.js                ← réorganisation par glisser-déposer
│       ├── fuzzy.js              ← recherche floue
│       ├── ui.js                 ← modales, menus, notifications, icônes
│       ├── i18n.js               ← traductions
│       └── api.js                ← accès au backend Rust
└── src-tauri/                    ← backend Rust
    ├── Cargo.toml / Cargo.lock
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/                    ← icon.ico + PNG
    └── src/
        ├── main.rs
        ├── lib.rs                ← assemblage, plugins, événements fenêtre
        ├── commands.rs           ← API appelée par l'interface
        ├── config.rs             ← JSON, mode portable, écriture atomique
        ├── launcher.rs           ← lancement, UAC, chemins cassés
        ├── icons.rs              ← extraction + cache + protocole icon://
        ├── startmenu.rs          ← import menu Démarrer + Store
        ├── shell.rs              ← COM, .lnk, variables %ENV%
        ├── tray.rs               ← zone de notification
        └── winutil.rs            ← fenêtre, multi-écrans, Mica, mémoire
```

---

## 3. Compiler sur Windows, pas à pas (débutant)

Comptez environ 20 minutes la première fois, surtout du téléchargement. Toutes les commandes se tapent dans **PowerShell** : clic droit sur le menu Démarrer, puis **Terminal**.

### Étape 1 : installer les outils (une seule fois)

Copiez-collez ces lignes une par une. Acceptez les fenêtres de confirmation (UAC) si elles apparaissent.

```powershell
# 1) Outils de compilation C++ de Microsoft (obligatoires pour Rust sous Windows, ~2 Go)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2) Rust
winget install --id Rustlang.Rustup -e

# 3) Node.js (version LTS)
winget install --id OpenJS.NodeJS.LTS -e

# 4) WebView2 : déjà présent sur Windows 10 à jour et Windows 11.
#    Si la commande dit « déjà installé », c'est parfait.
winget install --id Microsoft.EdgeWebView2Runtime -e
```

Ensuite, **fermez le terminal et rouvrez-en un nouveau** pour que Rust et Node soient reconnus. Vérifiez :

```powershell
rustc --version
node --version
```

Chaque commande doit afficher un numéro de version. Si `rustc` est introuvable, redémarrez le PC.

> `winget` n'existe pas ? Installez « App Installer » depuis le Microsoft Store, ou téléchargez manuellement : Build Tools (https://visualstudio.microsoft.com/fr/visual-cpp-build-tools/, cochez « Développement Desktop en C++ »), Rust (https://rustup.rs), Node.js LTS (https://nodejs.org).

### Étape 2 : récupérer le projet

Décompressez `lanette.zip` dans un dossier simple, par exemple `C:\Dev\lanette`. Évitez un dossier synchronisé OneDrive : la synchronisation ralentit fortement la compilation.

```powershell
cd C:\Dev\lanette
```

### Étape 3 : compiler

```powershell
npm install
npm run build
```

> Erreur « l'exécution de scripts est désactivée sur ce système » ? Tapez une fois `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (répondez O), puis relancez. Vous pouvez aussi utiliser `npm.cmd` à la place de `npm`.

La première compilation prend 3 à 10 minutes, les suivantes moins d'une minute. Vous obtenez :

| Fichier | Usage |
|---|---|
| `src-tauri\target\release\bundle\nsis\Lanette_1.0.0_x64-setup.exe` | **Installeur** à double-cliquer (sans droits administrateur) |
| `src-tauri\target\release\lanette.exe` | Exécutable seul (version portable) |

### Étape 4 (facultative) : mode développement

```powershell
npm run dev
```

L'application s'ouvre et se recharge quand vous modifiez les fichiers de `src\`.

### Version portable

Copiez `lanette.exe` dans un dossier (ou sur une clé USB), puis créez à côté un fichier vide nommé `portable` (ou `portable.txt`). Les données seront alors stockées dans un sous-dossier `data\` à côté de l'exe, et non dans AppData.

### Changer l'icône de l'application

Remplacez `app-icon.png` (1024×1024), puis lancez `npm run tauri icon app-icon.png`.

---

## 4. Compilation automatique sur GitHub

1. Créez un dépôt GitHub (privé ou public) et envoyez-y le projet.
2. Le workflow `.github/workflows/build-windows.yml` compile Lanette à chaque push sur une machine Windows de GitHub. Il vérifie aussi que l'exe et l'installeur font moins de 15 Mo.
3. Récupérez les fichiers dans l'onglet **Actions**, puis le dernier « Build Windows », puis **Artifacts** : l'installeur et `Lanette-portable.zip`.
4. **Publier une mise à jour** : augmentez le numéro de version (`version` dans `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` et `package.json`), puis fusionnez dans `main`. Le workflow crée alors automatiquement la Release GitHub `vX.Y.Z`, avec l'installeur et la version portable.

## Mises à jour depuis l'application

Dans **Paramètres**, section **À propos**, cliquez sur **Vérifier les mises à jour**. Le menu de l'icône de notification propose le même bouton. Lanette demande d'abord l'autorisation de se connecter à GitHub : elle ne se connecte jamais à Internet sans votre accord. Elle compare ensuite sa version à la dernière Release du dépôt. Si une version plus récente existe, elle affiche les nouveautés et un bouton **Télécharger et installer**. L'installeur est téléchargé, lancé en mode automatique, puis Lanette redémarre. Vos éléments et réglages sont conservés.

Ce bouton ne fonctionne que si le dépôt GitHub est **public** : un dépôt privé est invisible sans compte.

---

## 5. Utilisation

| Action | Clavier / souris |
|---|---|
| Afficher / masquer Lanette | **Alt+Espace** (modifiable) ou clic sur l'icône de notification |
| Rechercher | tapez directement (la recherche est active dès l'ouverture) |
| Sélectionner | clic |
| Lancer | **Entrée** ou double-clic |
| Lancer en administrateur | **Ctrl+Entrée**, Ctrl+double-clic ou menu contextuel |
| Ouvrir l'emplacement | **Maj+Entrée** |
| Se déplacer | **flèches**, Origine/Fin, Page préc./suiv. |
| Ajouter | **Ctrl+N**, bouton Ajouter, glisser-déposer, ou coller un lien / chemin dans la recherche |
| Retirer (avec Annuler) | **Suppr** |
| Renommer | **F2** |
| Favori | **Ctrl+D** |
| Menu de l'élément | clic droit, **Maj+F10** ou touche Menu |
| Changer de groupe | **Ctrl+Tab**, **Ctrl+1…9** |
| Paramètres | **Ctrl+,** |
| Effacer la recherche / masquer | **Échap** |

- **Réorganiser** : glissez une tuile au sein de sa section. Déposez-la sur un onglet pour la changer de groupe.
- **Ajouter par clic droit** : sur un onglet (ajoute dans ce groupe), sur « Tout » ou dans le vide de la liste.
- **Groupes** : bouton **+** à droite des onglets. Clic droit sur un onglet pour le renommer, le déplacer ou le supprimer.
- **Élément grisé** : son chemin n'existe plus. Cliquez dessus pour corriger le chemin ou le retirer.
- **« — » ou « × »** range la fenêtre dans la zone de notification. Cliquer ailleurs la laisse ouverte. Pour quitter : clic droit sur l'icône de notification, puis **Quitter**.

---

## 6. Vérifier les performances

- **Taille** : affichée par le workflow GitHub. En local, faites clic droit sur `lanette.exe`, puis Propriétés.
- **RAM et CPU au repos** : Gestionnaire des tâches, onglet Détails. Regardez `lanette.exe` et les processus `msedgewebview2.exe` qui dépendent de lui. Ou dans PowerShell :
  ```powershell
  Get-Process lanette, msedgewebview2 | Sort-Object WorkingSet64 -Desc | Select-Object Name, Id, @{n='Mo';e={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU
  ```
- **Ouverture** : la fenêtre n'est jamais recréée, seulement réaffichée. Le délai ressenti est celui de l'affichage par Windows.

Note honnête sur la RAM : le processus `lanette.exe` lui-même reste léger (de l'ordre de 10 à 25 Mo). En revanche, **WebView2 ajoute ses propres processus**, souvent 50 à 100 Mo au total, en partie partagés avec Edge. Lanette demande à WebView2 de libérer un maximum de mémoire dès que la fenêtre est masquée. Si un total strictement inférieur à 60 Mo est indispensable, seule une interface 100 % native (Win32/C++) le garantit.

---

## 7. Problèmes connus et solutions

| Problème | Solution |
|---|---|
| SmartScreen : « Windows a protégé votre ordinateur » | L'exe n'est pas signé. Cliquez sur **Informations complémentaires**, puis **Exécuter quand même**. Une signature de code payante supprime ce message. |
| L'antivirus bloque l'installeur ou l'exe | Faux positif fréquent pour les exe non signés et récents. Ajoutez une exclusion, ou compilez vous-même (vous savez alors ce qu'il contient). |
| Alt+Espace ne marche pas | Une autre application l'utilise (PowerToys Run par exemple). Lanette le signale au démarrage. Choisissez un autre raccourci dans Paramètres. |
| Le glisser-déposer depuis l'Explorateur ne marche pas | Lanette a été lancé « en tant qu'administrateur » : Windows interdit le dépôt d'une fenêtre normale vers une fenêtre administrateur. Lancez Lanette normalement et utilisez « lancer en administrateur » élément par élément. |
| « Lancement annulé » | Vous avez refusé la fenêtre UAC. Rien n'est cassé, relancez l'élément. |
| Erreur WebView2 au démarrage | Installez WebView2 avec `winget install Microsoft.EdgeWebView2Runtime`. L'installeur d'Lanette le fait automatiquement si nécessaire (il faut alors Internet une seule fois). |
| Glisser un lien depuis le navigateur ne fait rien | Copiez le lien puis collez-le dans la recherche (Ctrl+V) et appuyez sur Entrée. Ou glissez d'abord le lien sur le Bureau (cela crée un .url), puis déposez ce fichier dans Lanette. |

---

## 8. Choix faits sans vous demander

- **Nom « Lanette »** (celui du dépôt) et identifiant `fr.larma.lanette`, faciles à changer dans `tauri.conf.json`.
- **Installeur NSIS par utilisateur** : pas besoin de droits administrateur pour installer.
- **Fermer = masquer** dans la zone de notification. Quitter se fait par le menu de l'icône ou depuis les Paramètres.
- **Résultats de recherche toujours en liste** (avec le chemin), même en vue grille : plus lisible et plus rapide au clavier.
- **Clic = sélectionner, double-clic = lancer** (comme dans l'Explorateur). Clic droit = sélection + menu.
- **Chemins masqués par défaut** (bouton « Masquer les chemins » en haut à droite).
- **« — » et « × »** rangent Lanette dans la zone de notification (elle quitte la barre des tâches). **Cliquer ailleurs ne la masque pas** : elle reste ouverte et visible dans la barre des tâches.
- **Récents** : les 8 derniers lancés, dans l'onglet « Tout ». Les favoris apparaissent en tête de « Tout » et en tête de leur groupe.
- **Liens web** : pas de favicon téléchargé (respect du 100 % local). À la place, une pastille colorée avec l'initiale.
- **Mica sous Windows 11 uniquement**. Windows 10 a un fond opaque : son effet Acrylic rend le déplacement de fenêtre saccadé.
- **Les .exe sont lancés depuis leur propre dossier** si aucun dossier de travail n'est indiqué (indispensable pour beaucoup de jeux).
- **Les chemins réseau (\\\\serveur\\…) ne sont pas vérifiés**, pour ne jamais bloquer l'interface sur un serveur injoignable.
- **Raccourcis Steam / Epic (.url)** : importés depuis le menu Démarrer avec leur vraie icône.

---

## 9. Pistes d'amélioration

1. **Vérification des mises à jour au démarrage** (optionnelle), et **signature de l'installeur** pour vérifier son authenticité.
2. **Recherche étendue** optionnelle : fichiers récents de Windows, paramètres système (`ms-settings:`), calculatrice dans la barre de recherche.
3. **Profils et lancement groupé** : un clic lance un ensemble (ex. « Session jeu » = Discord + Steam + OBS), avec un délai entre chaque programme.
4. **Statistiques et tri intelligent** : temps de jeu par programme (en suivant le processus lancé), tri automatique par fréquence et heure d'utilisation.
5. **Langues supplémentaires** (anglais déjà prévu dans la structure) et **signature de code** de l'exe pour supprimer les alertes SmartScreen et antivirus.
