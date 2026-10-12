import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, Inbox, Plus } from "../icons";
import { ListRow, NewItemRow, Panel, PanelList, SheetOption } from "./parts";

type Project = { id: string; name: string };
type Section = { id: string; project_id: string; name: string };
type Pick = (patch: { project_id: string | null; section_id: string | null }) => void;

interface ProjectPanelProps {
  projects: Project[];
  sections: Section[];
  projectId: string | null | undefined;
  sectionId: string | null | undefined;
  /** The project whose sections are showing, or null for the project list. */
  step: string | null;
  pick: Pick;
  canCreate: boolean;
  newName: string;
  setNewName: (name: string) => void;
  onAdd: () => void;
}

export function ProjectWebPanel({
  projects,
  sections,
  projectId,
  sectionId,
  step,
  setStep,
  pick,
  canCreate,
  newName,
  setNewName,
  onAdd,
  onBack,
}: ProjectPanelProps & { setStep: (id: string | null) => void; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <Panel
      title={
        step
          ? (projects.find((p) => p.id === step)?.name ?? t("taskDetail.project"))
          : t("taskDetail.project")
      }
      onBack={step ? () => setStep(null) : onBack}
    >
      {step === null ? (
        <>
          {canCreate && (
            <NewItemRow
              compact
              icon={Plus}
              accessibilityLabel={t("quickAdd.newProjectName")}
              placeholder={t("nav.addProject") ?? "New project..."}
              value={newName}
              onChangeText={setNewName}
              onSubmit={onAdd}
              onEscape={onBack}
            />
          )}
          <PanelList>
            <ListRow
              label={t("moveTo.inbox")}
              selected={projectId === null}
              onPress={() => pick({ project_id: null, section_id: null })}
            />
            {projects.map((p) => {
              const hasSections = sections.some((s) => s.project_id === p.id);
              return (
                <ListRow
                  key={p.id}
                  label={p.name}
                  selected={projectId === p.id}
                  chevron={hasSections}
                  onPress={() => {
                    if (hasSections) {
                      setStep(p.id);
                    } else {
                      pick({ project_id: p.id, section_id: null });
                    }
                  }}
                />
              );
            })}
          </PanelList>
        </>
      ) : (
        <PanelList>
          <ListRow
            label={t("moveTo.noSection")}
            selected={projectId === step && sectionId == null}
            onPress={() => pick({ project_id: step, section_id: null })}
          />
          {sections
            .filter((s) => s.project_id === step)
            .map((s) => (
              <ListRow
                key={s.id}
                label={s.name}
                selected={projectId === step && sectionId === s.id}
                onPress={() => pick({ project_id: step, section_id: s.id })}
              />
            ))}
        </PanelList>
      )}
    </Panel>
  );
}

export function ProjectSheetBody({
  projects,
  sections,
  projectId,
  sectionId,
  step,
  onStepInto,
  pick,
  canCreate,
  newName,
  setNewName,
  onAdd,
}: ProjectPanelProps & { onStepInto: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 pb-4">
      {step === null ? (
        <>
          {canCreate && (
            <NewItemRow
              compact={false}
              icon={Plus}
              accessibilityLabel={t("quickAdd.newProjectName")}
              placeholder={t("nav.addProject") ?? "New project name..."}
              value={newName}
              onChangeText={setNewName}
              onSubmit={onAdd}
              autoCapitalize="words"
            />
          )}

          <SheetOption
            label={t("moveTo.inbox")}
            icon={Inbox}
            selected={projectId === null}
            onPress={() => pick({ project_id: null, section_id: null })}
          />

          {projects.map((p) => {
            const hasSections = sections.some((s) => s.project_id === p.id);
            const selected = projectId === p.id;
            return (
              <SheetOption
                key={p.id}
                label={p.name}
                icon={Folder}
                selected={selected}
                onPress={() => {
                  if (hasSections) {
                    onStepInto(p.id);
                  } else {
                    pick({ project_id: p.id, section_id: null });
                  }
                }}
                trailing={
                  <View className="flex-row items-center gap-2">
                    {selected && (
                      <Check size={20} className="text-accent-600 dark:text-accent-400" />
                    )}
                    {hasSections && (
                      <ChevronRight
                        size={20}
                        className={
                          selected ? "text-accent-600 dark:text-accent-400" : "text-neutral-500"
                        }
                      />
                    )}
                  </View>
                }
              />
            );
          })}
        </>
      ) : (
        <>
          <SheetOption
            label={t("moveTo.noSection")}
            selected={projectId === step && sectionId == null}
            onPress={() => pick({ project_id: step, section_id: null })}
          />
          {sections
            .filter((s) => s.project_id === step)
            .map((s) => (
              <SheetOption
                key={s.id}
                label={s.name}
                selected={projectId === step && sectionId === s.id}
                onPress={() => pick({ project_id: step, section_id: s.id })}
              />
            ))}
        </>
      )}
    </View>
  );
}
