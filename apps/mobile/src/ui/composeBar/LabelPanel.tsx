import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Tag } from "../icons";
import { ListRow, NewItemRow, Panel, PanelButton, PanelList, SheetOption } from "./parts";

type Label = { id: string; name: string; color?: string };

interface LabelPanelProps {
  labels: Label[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  canCreate: boolean;
  newName: string;
  setNewName: (name: string) => void;
  onAdd: () => void;
}

export function LabelWebPanel({
  labels,
  selectedIds,
  onToggle,
  canCreate,
  newName,
  setNewName,
  onAdd,
  onClose,
}: LabelPanelProps & { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Panel title={t("label.heading")} onBack={onClose}>
      {canCreate && (
        <NewItemRow
          compact
          icon={Tag}
          accessibilityLabel={t("quickAdd.newLabelName")}
          placeholder={t("label.addPlaceholder") ?? "New label..."}
          value={newName}
          onChangeText={setNewName}
          onSubmit={onAdd}
          onEscape={onClose}
        />
      )}
      <PanelList>
        {labels.length === 0 && (
          <Text className="px-2 py-2 text-xs text-neutral-500">{t("label.none")}</Text>
        )}
        {labels.map((l) => (
          <ListRow
            key={l.id}
            label={l.name}
            color={l.color}
            selected={selectedIds.includes(l.id)}
            onPress={() => onToggle(l.id)}
          />
        ))}
      </PanelList>
      <PanelButton label={t("common.done")} onPress={onClose} />
    </Panel>
  );
}

export function LabelSheetBody({
  labels,
  selectedIds,
  onToggle,
  canCreate,
  newName,
  setNewName,
  onAdd,
}: LabelPanelProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 pb-4">
      {canCreate && (
        <NewItemRow
          compact={false}
          icon={Tag}
          accessibilityLabel={t("quickAdd.newLabelName")}
          placeholder={t("label.addPlaceholder") ?? "New label name..."}
          value={newName}
          onChangeText={setNewName}
          onSubmit={onAdd}
          autoCapitalize="none"
        />
      )}

      {labels.length === 0 && (
        <Text className="py-6 text-center text-sm text-neutral-500">{t("label.none")}</Text>
      )}
      {labels.map((l) => {
        const selected = selectedIds.includes(l.id);
        return (
          <SheetOption
            key={l.id}
            role="checkbox"
            accessibilityState={{ checked: selected }}
            label={l.name}
            leading={
              <View
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: l.color ?? "#a1a1aa" }}
              />
            }
            selected={selected}
            onPress={() => onToggle(l.id)}
          />
        );
      })}
    </View>
  );
}
