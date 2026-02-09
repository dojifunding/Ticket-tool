// ─── ProjectHub Internationalization ──────────────────
// All UI strings in French and English

const translations = {

  // ═══════════════════════════════════════════════════
  //  COMMON / SHARED
  // ═══════════════════════════════════════════════════
  fr: {
    lang: 'fr',
    langLabel: 'FR',
    langFull: 'Français',

    // ─── Global ────────────────────────────────────
    projectHub: 'ProjectHub',
    search_placeholder: 'Rechercher tickets, tâches, projets...',
    online_users: 'Utilisateurs en ligne',
    notifications: 'Notifications',
    mark_all_read: 'Tout lire',
    no_notifications: 'Aucune notification',
    logout: 'Déconnexion',
    cancel: 'Annuler',
    save: 'Enregistrer',
    delete_btn: 'Supprimer',
    update: 'Mettre à jour',
    create: 'Créer',
    send: 'Envoyer',
    back: 'Retour',
    yes: 'Oui',
    no: 'Non',
    or: 'ou',
    none: 'Aucun',
    actions: 'Actions',
    you: 'Vous',
    loading: 'Chargement...',
    no_description: 'Aucune description',
    no_description_provided: 'Aucune description fournie.',
    just_now: "À l'instant",
    not_assigned: 'Non assigné',

    // ─── Roles ─────────────────────────────────────
    role_admin: '👑 Admin',
    role_developer: '👨‍💻 Développeur',
    role_developer_short: '👨‍💻 Dev',
    role_support: '🎧 Support',

    // ─── Sidebar Nav ───────────────────────────────
    nav_administration: 'Administration',
    nav_dashboard: 'Dashboard',
    nav_users: 'Utilisateurs',
    nav_development: 'Développement',
    nav_projects: 'Projets',
    nav_support: 'Support',
    nav_tickets: 'Tickets',
    nav_new_ticket: 'Nouveau ticket',

    // ─── Statuses (tasks) ──────────────────────────
    status_backlog: 'Backlog',
    status_todo: 'À faire',
    status_in_progress: 'En cours',
    status_review: 'En revue',
    status_done: 'Terminé',

    // ─── Statuses (tickets) ────────────────────────
    tstatus_open: 'Ouvert',
    tstatus_in_progress: 'En cours',
    tstatus_waiting: 'En attente',
    tstatus_resolved: 'Résolu',
    tstatus_closed: 'Fermé',

    // ─── Priorities ────────────────────────────────
    priority_low: '🟢 Basse',
    priority_medium: '🟡 Moyenne',
    priority_high: '🟠 Haute',
    priority_critical: '🔴 Critique',
    priority_urgent: '🔴 Urgent',
    priority_label_low: 'Basse',
    priority_label_medium: 'Moyenne',
    priority_label_high: 'Haute',
    priority_label_critical: 'Critique',

    // ─── Task types ────────────────────────────────
    type_task: '📋 Tâche',
    type_bug: '🐛 Bug',
    type_feature: '✨ Fonctionnalité',
    type_improvement: '💡 Amélioration',
    type_escalation: '🔺 Escalade',

    // ─── Categories (tickets) ──────────────────────
    cat_general: 'Général',
    cat_bug: 'Bug',
    cat_question: 'Question',
    cat_feature_request: 'Demande de fonctionnalité',
    cat_account: 'Compte',
    cat_billing: 'Facturation',
    cat_other: 'Autre',

    // ─── Form labels ───────────────────────────────
    label_status: 'Statut',
    label_priority: 'Priorité',
    label_type: 'Type',
    label_assigned_to: 'Assigné à',
    label_category: 'Catégorie',
    label_due_date: 'Date limite',
    label_created_by: 'Créé par',
    label_created_at: 'Créé le',
    label_updated_at: 'Modifié le',
    label_resolved_at: 'Résolu le',

    // ═══════════════════════════════════════════════
    //  LOGIN PAGE
    // ═══════════════════════════════════════════════
    login_title: 'Connexion',
    login_subtitle: 'Connectez-vous à votre espace de travail',
    login_username: 'Identifiant',
    login_username_placeholder: 'Votre identifiant',
    login_password: 'Mot de passe',
    login_password_placeholder: 'Votre mot de passe',
    login_submit: 'Se connecter',
    login_demo_title: 'Comptes de démonstration :',
    login_error: 'Identifiant ou mot de passe incorrect',

    // ═══════════════════════════════════════════════
    //  ERROR PAGE
    // ═══════════════════════════════════════════════
    error_title: 'Erreur',
    error_not_found_title: 'Page introuvable',
    error_not_found_msg: "La page que vous recherchez n'existe pas.",
    error_server_title: 'Erreur serveur',
    error_server_msg: 'Une erreur interne est survenue.',
    error_back_home: "Retour à l'accueil",
    error_back_login: 'Connexion',

    // ═══════════════════════════════════════════════
    //  ADMIN DASHBOARD
    // ═══════════════════════════════════════════════
    admin_title: 'Dashboard Administration',
    admin_subtitle: "Vue d'ensemble de l'activité",
    admin_quick_projects: '👨‍💻 Projets',
    admin_quick_tickets: '🎧 Tickets',
    admin_stat_users: 'Utilisateurs actifs',
    admin_stat_projects: 'Projets actifs',
    admin_stat_tasks: 'Tâches en cours',
    admin_stat_open_tickets: 'Tickets ouverts',
    admin_stat_urgent: 'Tickets urgents',
    admin_stat_escalations: 'Escalades actives',
    admin_chart_tickets: 'Tickets par statut',
    admin_chart_tasks: 'Tâches par statut',
    admin_recent_activity: 'Activité récente',
    admin_no_activity: 'Aucune activité enregistrée.',

    // ═══════════════════════════════════════════════
    //  ADMIN USERS
    // ═══════════════════════════════════════════════
    users_title: 'Gestion des utilisateurs',
    users_count: 'utilisateur(s) enregistrés',
    users_back: '← Dashboard',
    users_error_duplicate: "⚠️ Erreur : ce nom d'utilisateur ou email existe déjà.",
    users_tasks: 'Tâches',
    users_tickets: 'Tickets',
    users_status: 'Statut',
    users_disable: 'Désactiver',
    users_enable: 'Activer',
    users_new_title: '➕ Nouvel utilisateur',
    users_fullname: 'Nom complet',
    users_fullname_placeholder: 'Jean Dupont',
    users_username: 'Identifiant',
    users_username_placeholder: 'jdupont',
    users_role: 'Rôle',
    users_email: 'Email',
    users_email_placeholder: 'jean@entreprise.com',
    users_password: 'Mot de passe',
    users_create: "Créer l'utilisateur",
    users_role_developer: 'Développeur',
    users_role_support: 'Support',
    users_role_admin: 'Admin',

    // ═══════════════════════════════════════════════
    //  PROJECTS LIST
    // ═══════════════════════════════════════════════
    projects_title: 'Projets',
    projects_count_suffix: 'projet(s)',
    projects_new: 'Nouveau projet',
    projects_tasks_count: 'tâches',
    projects_view_board: 'Voir le board →',
    projects_empty_title: 'Aucun projet',
    projects_empty_text: 'Créez votre premier projet pour commencer',

    // ═══════════════════════════════════════════════
    //  PROJECT FORM
    // ═══════════════════════════════════════════════
    project_form_new: 'Nouveau projet',
    project_form_edit: 'Modifier le projet',
    project_form_back: '← Retour aux projets',
    project_form_name: 'Nom du projet *',
    project_form_name_placeholder: 'Ex: Site Web Corporate',
    project_form_code: 'Code *',
    project_form_code_placeholder: 'Ex: SWC',
    project_form_code_hint: '3-6 caractères, unique',
    project_form_description: 'Description',
    project_form_desc_placeholder: 'Décrivez le projet...',
    project_form_color: 'Couleur',
    project_form_create: 'Créer le projet',
    project_form_error_code: 'Ce code projet existe déjà',
    project_form_error_generic: 'Erreur lors de la création',

    // ═══════════════════════════════════════════════
    //  KANBAN BOARD
    // ═══════════════════════════════════════════════
    board_subtitle: 'Board Kanban',
    board_new_task: 'Nouvelle tâche',
    board_modal_title: 'Nouvelle tâche',
    board_task_title: 'Titre *',
    board_task_title_placeholder: 'Ex: Corriger le bug de connexion',
    board_task_description: 'Description',
    board_task_desc_placeholder: 'Décrivez la tâche...',
    board_task_create: 'Créer la tâche',

    // ═══════════════════════════════════════════════
    //  TASK DETAIL
    // ═══════════════════════════════════════════════
    task_back_board: 'Board',
    task_escalated_from: 'Escaladé depuis le ticket',
    task_description: 'Description',
    task_comments: 'Commentaires',
    task_no_comments: 'Aucun commentaire pour le moment.',
    task_comment_placeholder: 'Écrire un commentaire...',
    task_delete: 'Supprimer la tâche',
    task_delete_confirm: 'Supprimer cette tâche ?',
    task_feature: 'Feature',

    // ═══════════════════════════════════════════════
    //  TICKETS LIST
    // ═══════════════════════════════════════════════
    tickets_title: 'Tickets Support',
    tickets_count_suffix: 'ticket(s) au total',
    tickets_new: 'Nouveau ticket',
    tickets_stat_open: 'Ouverts',
    tickets_stat_progress: 'En cours',
    tickets_stat_waiting: 'En attente',
    tickets_stat_resolved: 'Résolus',
    tickets_filter_all_status: 'Tous les statuts',
    tickets_filter_all_priority: 'Toutes les priorités',
    tickets_filter_all_agents: 'Tous les agents',
    tickets_filter_my: 'Mes tickets',
    tickets_filter_unassigned: 'Non assignés',
    tickets_filter_search: 'Rechercher...',
    tickets_col_ref: 'Réf.',
    tickets_col_subject: 'Sujet',
    tickets_col_client: 'Client',
    tickets_col_priority: 'Priorité',
    tickets_col_status: 'Statut',
    tickets_col_assigned: 'Assigné à',
    tickets_col_updated: 'Mis à jour',
    tickets_empty: 'Aucun ticket trouvé',

    // ═══════════════════════════════════════════════
    //  TICKET FORM
    // ═══════════════════════════════════════════════
    ticket_form_title: 'Nouveau ticket',
    ticket_form_back: '← Tickets',
    ticket_form_subject: 'Sujet *',
    ticket_form_subject_placeholder: 'Ex: Impossible de se connecter au compte',
    ticket_form_description: 'Description détaillée *',
    ticket_form_desc_placeholder: "Décrivez le problème en détail : ce que l'utilisateur a fait, ce qu'il s'est passé, le message d'erreur éventuel...",
    ticket_form_client_name: 'Nom du client',
    ticket_form_client_name_placeholder: 'Jean Dupont',
    ticket_form_client_email: 'Email du client',
    ticket_form_client_email_placeholder: 'jean@example.com',
    ticket_form_assign: 'Assigner à',
    ticket_form_create: 'Créer le ticket',

    // ═══════════════════════════════════════════════
    //  TICKET DETAIL
    // ═══════════════════════════════════════════════
    ticket_back: '← Tickets',
    ticket_escalated_to_dev: "Escaladé vers l'équipe développement",
    ticket_see_task: 'Voir la tâche dans',
    ticket_project_status: 'Projet:',
    ticket_description_title: 'Description du problème',
    ticket_conversation: 'Conversation',
    ticket_no_messages: 'Aucun message. Ajoutez le premier message ci-dessous.',
    ticket_message_placeholder: 'Écrire un message...',
    ticket_internal_note: 'Note interne (invisible pour le client)',
    ticket_internal_badge: 'Note interne',
    ticket_escalate_title: '🔺 Escalader aux développeurs',
    ticket_escalate_subtitle: "Signaler ce problème à l'équipe technique",
    ticket_escalate_project: 'Projet cible *',
    ticket_escalate_project_placeholder: 'Choisir un projet',
    ticket_escalate_task_title: 'Titre de la tâche',
    ticket_escalate_confirm: "Escalader ce ticket à l'équipe de développement ?",
    ticket_escalate_btn: '🔺 Escalader',
    ticket_status_label: 'statut:',

    // ═══════════════════════════════════════════════
    //  HELP CENTER
    // ═══════════════════════════════════════════════
    help_title: 'Centre d\'aide',
    help_hero_title: 'Comment pouvons-nous vous aider ?',
    help_hero_subtitle: 'Recherchez dans notre base de connaissances ou parcourez les catégories ci-dessous',
    help_search_placeholder: 'Rechercher un article, un sujet...',
    help_search_btn: 'Rechercher',
    help_search: 'Recherche',
    help_search_results: 'Résultats pour',
    help_articles: 'articles',
    help_popular: 'Articles populaires',
    help_staff_only: 'Staff uniquement',
    help_back_home: 'Retour à l\'accueil',
    help_back_app: 'Retour à l\'app',
    help_no_results: 'Aucun résultat trouvé',
    help_no_results_text: 'Essayez d\'autres termes de recherche ou parcourez les catégories.',
    help_no_articles: 'Aucun article dans cette catégorie.',
    help_related: 'Articles connexes',
    help_views: 'vues',
    help_still_need_help: 'Vous n\'avez pas trouvé la réponse ? Contactez notre support.',
    help_contact_title: 'Besoin d\'aide supplémentaire ?',
    help_contact_text: 'Notre équipe support est là pour vous aider. Créez un ticket et nous vous répondrons rapidement.',
    help_contact_btn: 'Contacter le support',
    help_footer: 'Tous droits réservés',

    // ═══════════════════════════════════════════════
    //  ARTICLES ADMIN
    // ═══════════════════════════════════════════════
    nav_articles: 'Articles FAQ',
    nav_help_center: 'Centre d\'aide',
    articles_title: 'Articles du Centre d\'aide',
    articles_count: 'article(s)',
    articles_new: 'Nouvel article',
    articles_edit: 'Modifier l\'article',
    articles_create: 'Créer l\'article',
    articles_view_public: 'Voir le Help Center',
    articles_public: 'Public',
    articles_private: 'Privé',
    articles_public_desc: 'Visible par tous',
    articles_private_desc: 'Staff uniquement',
    articles_published: 'Publié',
    articles_draft: 'Brouillon',
    articles_publish: 'Publier',
    articles_unpublish: 'Dépublier',
    articles_preview: 'Aperçu',
    articles_delete_confirm: 'Supprimer cet article ?',
    articles_empty: 'Aucun article. Créez le premier !',
    articles_no_category: 'Sans catégorie',
    articles_col_title: 'Titre',
    articles_col_category: 'Catégorie',
    articles_col_visibility: 'Visibilité',
    articles_col_status: 'Statut',
    articles_col_views: 'Vues',
    articles_col_updated: 'Mis à jour',
    articles_form_title_fr: 'Titre (Français)',
    articles_form_title_en: 'Titre (Anglais)',
    articles_form_title_placeholder: 'Ex: Comment réinitialiser mon mot de passe ?',
    articles_form_excerpt_fr: 'Résumé (FR)',
    articles_form_excerpt_en: 'Résumé (EN)',
    articles_form_excerpt_placeholder: 'Court résumé de l\'article',
    articles_form_content_fr: 'Contenu (Français)',
    articles_form_content_en: 'Contenu (Anglais)',
    articles_form_content_placeholder: '## Mon titre\n\nContenu en Markdown...',

    // ─── AI ────────────────────────────────────────
    articles_ai_generate: 'Générer avec l\'IA',
    articles_ai_not_configured: '💡 Pour activer l\'IA : ajoutez la variable d\'environnement ANTHROPIC_API_KEY dans les paramètres de Render.',
    articles_ai_modal_title: 'Génération d\'article par IA',
    articles_ai_from_title: 'À partir d\'un titre',
    articles_ai_from_content: 'À partir d\'un contenu',
    articles_ai_article_title: 'Titre de l\'article',
    articles_ai_title_placeholder: 'Ex: Comment configurer l\'authentification à deux facteurs ?',
    articles_ai_resources: 'Ressources / Informations',
    articles_ai_resources_placeholder: 'Collez ici les informations, notes, documentation... L\'IA s\'en servira pour rédiger l\'article.',
    articles_ai_paste_content: 'Contenu à analyser',
    articles_ai_paste_placeholder: 'Collez un document, des notes, un email... L\'IA en extraira des articles FAQ.',
    articles_ai_generate_btn: 'Générer l\'article',
    articles_ai_analyze_btn: 'Analyser et générer',
    articles_ai_result: 'Résultat généré',
    articles_ai_use: 'Utiliser ce contenu',
    articles_ai_tools: 'Outils IA :',
    articles_ai_generate_content: 'Générer le contenu',
    articles_ai_need_title: 'Veuillez d\'abord saisir un titre.',
    ticket_ai_suggest: 'Suggestion IA',
    ticket_faq_title: 'Articles FAQ',
    ticket_faq_search: 'Rechercher un article...',
    ticket_faq_insert: 'Insérer',
    ticket_faq_ref_prefix: 'Pour plus d\'informations, consultez notre article',
  },

  // ═══════════════════════════════════════════════════
  //  ENGLISH TRANSLATIONS
  // ═══════════════════════════════════════════════════
  en: {
    lang: 'en',
    langLabel: 'EN',
    langFull: 'English',

    // ─── Global ────────────────────────────────────
    projectHub: 'ProjectHub',
    search_placeholder: 'Search tickets, tasks, projects...',
    online_users: 'Online users',
    notifications: 'Notifications',
    mark_all_read: 'Mark all read',
    no_notifications: 'No notifications',
    logout: 'Log out',
    cancel: 'Cancel',
    save: 'Save',
    delete_btn: 'Delete',
    update: 'Update',
    create: 'Create',
    send: 'Send',
    back: 'Back',
    yes: 'Yes',
    no: 'No',
    or: 'or',
    none: 'None',
    actions: 'Actions',
    you: 'You',
    loading: 'Loading...',
    no_description: 'No description',
    no_description_provided: 'No description provided.',
    just_now: 'Just now',
    not_assigned: 'Unassigned',

    // ─── Roles ─────────────────────────────────────
    role_admin: '👑 Admin',
    role_developer: '👨‍💻 Developer',
    role_developer_short: '👨‍💻 Dev',
    role_support: '🎧 Support',

    // ─── Sidebar Nav ───────────────────────────────
    nav_administration: 'Administration',
    nav_dashboard: 'Dashboard',
    nav_users: 'Users',
    nav_development: 'Development',
    nav_projects: 'Projects',
    nav_support: 'Support',
    nav_tickets: 'Tickets',
    nav_new_ticket: 'New ticket',

    // ─── Statuses (tasks) ──────────────────────────
    status_backlog: 'Backlog',
    status_todo: 'To Do',
    status_in_progress: 'In Progress',
    status_review: 'In Review',
    status_done: 'Done',

    // ─── Statuses (tickets) ────────────────────────
    tstatus_open: 'Open',
    tstatus_in_progress: 'In Progress',
    tstatus_waiting: 'Waiting',
    tstatus_resolved: 'Resolved',
    tstatus_closed: 'Closed',

    // ─── Priorities ────────────────────────────────
    priority_low: '🟢 Low',
    priority_medium: '🟡 Medium',
    priority_high: '🟠 High',
    priority_critical: '🔴 Critical',
    priority_urgent: '🔴 Urgent',
    priority_label_low: 'Low',
    priority_label_medium: 'Medium',
    priority_label_high: 'High',
    priority_label_critical: 'Critical',

    // ─── Task types ────────────────────────────────
    type_task: '📋 Task',
    type_bug: '🐛 Bug',
    type_feature: '✨ Feature',
    type_improvement: '💡 Improvement',
    type_escalation: '🔺 Escalation',

    // ─── Categories (tickets) ──────────────────────
    cat_general: 'General',
    cat_bug: 'Bug',
    cat_question: 'Question',
    cat_feature_request: 'Feature Request',
    cat_account: 'Account',
    cat_billing: 'Billing',
    cat_other: 'Other',

    // ─── Form labels ───────────────────────────────
    label_status: 'Status',
    label_priority: 'Priority',
    label_type: 'Type',
    label_assigned_to: 'Assigned to',
    label_category: 'Category',
    label_due_date: 'Due date',
    label_created_by: 'Created by',
    label_created_at: 'Created on',
    label_updated_at: 'Updated on',
    label_resolved_at: 'Resolved on',

    // ═══════════════════════════════════════════════
    //  LOGIN PAGE
    // ═══════════════════════════════════════════════
    login_title: 'Login',
    login_subtitle: 'Sign in to your workspace',
    login_username: 'Username',
    login_username_placeholder: 'Your username',
    login_password: 'Password',
    login_password_placeholder: 'Your password',
    login_submit: 'Sign in',
    login_demo_title: 'Demo accounts:',
    login_error: 'Invalid username or password',

    // ═══════════════════════════════════════════════
    //  ERROR PAGE
    // ═══════════════════════════════════════════════
    error_title: 'Error',
    error_not_found_title: 'Page not found',
    error_not_found_msg: 'The page you are looking for does not exist.',
    error_server_title: 'Server error',
    error_server_msg: 'An internal error occurred.',
    error_back_home: 'Back to home',
    error_back_login: 'Login',

    // ═══════════════════════════════════════════════
    //  ADMIN DASHBOARD
    // ═══════════════════════════════════════════════
    admin_title: 'Administration Dashboard',
    admin_subtitle: 'Activity overview',
    admin_quick_projects: '👨‍💻 Projects',
    admin_quick_tickets: '🎧 Tickets',
    admin_stat_users: 'Active users',
    admin_stat_projects: 'Active projects',
    admin_stat_tasks: 'Tasks in progress',
    admin_stat_open_tickets: 'Open tickets',
    admin_stat_urgent: 'Urgent tickets',
    admin_stat_escalations: 'Active escalations',
    admin_chart_tickets: 'Tickets by status',
    admin_chart_tasks: 'Tasks by status',
    admin_recent_activity: 'Recent activity',
    admin_no_activity: 'No activity recorded.',

    // ═══════════════════════════════════════════════
    //  ADMIN USERS
    // ═══════════════════════════════════════════════
    users_title: 'User Management',
    users_count: 'registered user(s)',
    users_back: '← Dashboard',
    users_error_duplicate: '⚠️ Error: this username or email already exists.',
    users_tasks: 'Tasks',
    users_tickets: 'Tickets',
    users_status: 'Status',
    users_disable: 'Disable',
    users_enable: 'Enable',
    users_new_title: '➕ New user',
    users_fullname: 'Full name',
    users_fullname_placeholder: 'John Smith',
    users_username: 'Username',
    users_username_placeholder: 'jsmith',
    users_role: 'Role',
    users_email: 'Email',
    users_email_placeholder: 'john@company.com',
    users_password: 'Password',
    users_create: 'Create user',
    users_role_developer: 'Developer',
    users_role_support: 'Support',
    users_role_admin: 'Admin',

    // ═══════════════════════════════════════════════
    //  PROJECTS LIST
    // ═══════════════════════════════════════════════
    projects_title: 'Projects',
    projects_count_suffix: 'project(s)',
    projects_new: 'New project',
    projects_tasks_count: 'tasks',
    projects_view_board: 'View board →',
    projects_empty_title: 'No projects',
    projects_empty_text: 'Create your first project to get started',

    // ═══════════════════════════════════════════════
    //  PROJECT FORM
    // ═══════════════════════════════════════════════
    project_form_new: 'New Project',
    project_form_edit: 'Edit Project',
    project_form_back: '← Back to projects',
    project_form_name: 'Project name *',
    project_form_name_placeholder: 'E.g.: Corporate Website',
    project_form_code: 'Code *',
    project_form_code_placeholder: 'E.g.: CW',
    project_form_code_hint: '3-6 characters, unique',
    project_form_description: 'Description',
    project_form_desc_placeholder: 'Describe the project...',
    project_form_color: 'Color',
    project_form_create: 'Create project',
    project_form_error_code: 'This project code already exists',
    project_form_error_generic: 'Error during creation',

    // ═══════════════════════════════════════════════
    //  KANBAN BOARD
    // ═══════════════════════════════════════════════
    board_subtitle: 'Kanban Board',
    board_new_task: 'New task',
    board_modal_title: 'New task',
    board_task_title: 'Title *',
    board_task_title_placeholder: 'E.g.: Fix the login bug',
    board_task_description: 'Description',
    board_task_desc_placeholder: 'Describe the task...',
    board_task_create: 'Create task',

    // ═══════════════════════════════════════════════
    //  TASK DETAIL
    // ═══════════════════════════════════════════════
    task_back_board: 'Board',
    task_escalated_from: 'Escalated from ticket',
    task_description: 'Description',
    task_comments: 'Comments',
    task_no_comments: 'No comments yet.',
    task_comment_placeholder: 'Write a comment...',
    task_delete: 'Delete task',
    task_delete_confirm: 'Delete this task?',
    task_feature: 'Feature',

    // ═══════════════════════════════════════════════
    //  TICKETS LIST
    // ═══════════════════════════════════════════════
    tickets_title: 'Support Tickets',
    tickets_count_suffix: 'total ticket(s)',
    tickets_new: 'New ticket',
    tickets_stat_open: 'Open',
    tickets_stat_progress: 'In Progress',
    tickets_stat_waiting: 'Waiting',
    tickets_stat_resolved: 'Resolved',
    tickets_filter_all_status: 'All statuses',
    tickets_filter_all_priority: 'All priorities',
    tickets_filter_all_agents: 'All agents',
    tickets_filter_my: 'My tickets',
    tickets_filter_unassigned: 'Unassigned',
    tickets_filter_search: 'Search...',
    tickets_col_ref: 'Ref.',
    tickets_col_subject: 'Subject',
    tickets_col_client: 'Client',
    tickets_col_priority: 'Priority',
    tickets_col_status: 'Status',
    tickets_col_assigned: 'Assigned to',
    tickets_col_updated: 'Updated',
    tickets_empty: 'No tickets found',

    // ═══════════════════════════════════════════════
    //  TICKET FORM
    // ═══════════════════════════════════════════════
    ticket_form_title: 'New ticket',
    ticket_form_back: '← Tickets',
    ticket_form_subject: 'Subject *',
    ticket_form_subject_placeholder: 'E.g.: Unable to log into account',
    ticket_form_description: 'Detailed description *',
    ticket_form_desc_placeholder: "Describe the issue in detail: what the user did, what happened, any error messages...",
    ticket_form_client_name: 'Client name',
    ticket_form_client_name_placeholder: 'John Smith',
    ticket_form_client_email: 'Client email',
    ticket_form_client_email_placeholder: 'john@example.com',
    ticket_form_assign: 'Assign to',
    ticket_form_create: 'Create ticket',

    // ═══════════════════════════════════════════════
    //  TICKET DETAIL
    // ═══════════════════════════════════════════════
    ticket_back: '← Tickets',
    ticket_escalated_to_dev: 'Escalated to development team',
    ticket_see_task: 'View task in',
    ticket_project_status: 'Project:',
    ticket_description_title: 'Problem description',
    ticket_conversation: 'Conversation',
    ticket_no_messages: 'No messages. Add the first message below.',
    ticket_message_placeholder: 'Write a message...',
    ticket_internal_note: 'Internal note (invisible to client)',
    ticket_internal_badge: 'Internal note',
    ticket_escalate_title: '🔺 Escalate to developers',
    ticket_escalate_subtitle: 'Report this issue to the technical team',
    ticket_escalate_project: 'Target project *',
    ticket_escalate_project_placeholder: 'Choose a project',
    ticket_escalate_task_title: 'Task title',
    ticket_escalate_confirm: 'Escalate this ticket to the development team?',
    ticket_escalate_btn: '🔺 Escalate',
    ticket_status_label: 'status:',

    // ═══════════════════════════════════════════════
    //  HELP CENTER
    // ═══════════════════════════════════════════════
    help_title: 'Help Center',
    help_hero_title: 'How can we help you?',
    help_hero_subtitle: 'Search our knowledge base or browse the categories below',
    help_search_placeholder: 'Search for an article, a topic...',
    help_search_btn: 'Search',
    help_search: 'Search',
    help_search_results: 'Results for',
    help_articles: 'articles',
    help_popular: 'Popular articles',
    help_staff_only: 'Staff only',
    help_back_home: 'Back to home',
    help_back_app: 'Back to app',
    help_no_results: 'No results found',
    help_no_results_text: 'Try different search terms or browse the categories.',
    help_no_articles: 'No articles in this category.',
    help_related: 'Related articles',
    help_views: 'views',
    help_still_need_help: 'Didn\'t find the answer? Contact our support team.',
    help_contact_title: 'Need more help?',
    help_contact_text: 'Our support team is here to help. Create a ticket and we\'ll get back to you quickly.',
    help_contact_btn: 'Contact support',
    help_footer: 'All rights reserved',

    // ═══════════════════════════════════════════════
    //  ARTICLES ADMIN
    // ═══════════════════════════════════════════════
    nav_articles: 'FAQ Articles',
    nav_help_center: 'Help Center',
    articles_title: 'Help Center Articles',
    articles_count: 'article(s)',
    articles_new: 'New article',
    articles_edit: 'Edit article',
    articles_create: 'Create article',
    articles_view_public: 'View Help Center',
    articles_public: 'Public',
    articles_private: 'Private',
    articles_public_desc: 'Visible to everyone',
    articles_private_desc: 'Staff only',
    articles_published: 'Published',
    articles_draft: 'Draft',
    articles_publish: 'Publish',
    articles_unpublish: 'Unpublish',
    articles_preview: 'Preview',
    articles_delete_confirm: 'Delete this article?',
    articles_empty: 'No articles yet. Create the first one!',
    articles_no_category: 'No category',
    articles_col_title: 'Title',
    articles_col_category: 'Category',
    articles_col_visibility: 'Visibility',
    articles_col_status: 'Status',
    articles_col_views: 'Views',
    articles_col_updated: 'Updated',
    articles_form_title_fr: 'Title (French)',
    articles_form_title_en: 'Title (English)',
    articles_form_title_placeholder: 'E.g.: How to reset my password?',
    articles_form_excerpt_fr: 'Excerpt (FR)',
    articles_form_excerpt_en: 'Excerpt (EN)',
    articles_form_excerpt_placeholder: 'Short article summary',
    articles_form_content_fr: 'Content (French)',
    articles_form_content_en: 'Content (English)',
    articles_form_content_placeholder: '## My title\n\nContent in Markdown...',

    // ─── AI ────────────────────────────────────────
    articles_ai_generate: 'Generate with AI',
    articles_ai_not_configured: '💡 To enable AI: add the ANTHROPIC_API_KEY environment variable in your Render settings.',
    articles_ai_modal_title: 'AI Article Generation',
    articles_ai_from_title: 'From a title',
    articles_ai_from_content: 'From content',
    articles_ai_article_title: 'Article title',
    articles_ai_title_placeholder: 'E.g.: How to set up two-factor authentication?',
    articles_ai_resources: 'Resources / Information',
    articles_ai_resources_placeholder: 'Paste information, notes, documentation here... The AI will use it to write the article.',
    articles_ai_paste_content: 'Content to analyze',
    articles_ai_paste_placeholder: 'Paste a document, notes, an email... The AI will extract FAQ articles from it.',
    articles_ai_generate_btn: 'Generate article',
    articles_ai_analyze_btn: 'Analyze and generate',
    articles_ai_result: 'Generated result',
    articles_ai_use: 'Use this content',
    articles_ai_tools: 'AI Tools:',
    articles_ai_generate_content: 'Generate content',
    articles_ai_need_title: 'Please enter a title first.',
    ticket_ai_suggest: 'AI Suggestion',
    ticket_faq_title: 'FAQ Articles',
    ticket_faq_search: 'Search an article...',
    ticket_faq_insert: 'Insert',
    ticket_faq_ref_prefix: 'For more information, see our article',
  }
};

function getTranslations(lang) {
  return translations[lang] || translations.fr;
}

function getDateLocale(lang) {
  return lang === 'en' ? 'en-GB' : 'fr-FR';
}

module.exports = { getTranslations, getDateLocale };
